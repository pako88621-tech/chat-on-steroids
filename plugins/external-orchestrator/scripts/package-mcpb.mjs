import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDeterministicZip } from './deterministic-zip.mjs';
import { runMcpb, runNpm } from './package-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.mcpb-stage');
const release = path.join(root, 'release');
const REQUIRED_METADATA = [
  'manifest.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md',
  'PROVENANCE.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE.md',
];
const EXPECTED_PACKAGE = '@chat-on-steroids/external-orchestrator';
const EXPECTED_MANIFEST = 'chat-on-steroids-external-orchestrator';
const EXPECTED_TOOLS = ['cos_orchestrate', 'cos_evidence'];

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const configSource = await fs.readFile(path.join(root, 'src', 'config.ts'), 'utf8');
const versionSource = await fs.readFile(path.join(root, 'src', 'version.ts'), 'utf8');
const protocolMatch = configSource.match(/export const CONTROL_API_PROTOCOL\s*=\s*(\d+)\s*;/u);
const versionMatch = versionSource.match(/EXTERNAL_ORCHESTRATOR_VERSION\s*=\s*['"]([^'"]+)['"]/u);
const controlApiProtocol = Number(protocolMatch?.[1]);
if (
  pkg.name !== EXPECTED_PACKAGE || pkg.version !== manifest.version || manifest.name !== EXPECTED_MANIFEST ||
  versionMatch?.[1] !== pkg.version ||
  manifest.manifest_version !== '0.3' || manifest.server?.type !== 'node' || manifest.server?.entry_point !== 'dist/stdio.js' ||
  manifest.server?.mcp_config?.command !== 'node' || JSON.stringify(manifest.server?.mcp_config?.args) !== JSON.stringify(['${__dirname}/dist/stdio.js']) ||
  JSON.stringify((manifest.tools ?? []).map(tool => tool.name)) !== JSON.stringify(EXPECTED_TOOLS) ||
  JSON.stringify(manifest.compatibility?.platforms) !== JSON.stringify(['darwin', 'win32', 'linux']) ||
  manifest.compatibility?.runtimes?.node !== '>=20' || pkg.engines?.node !== '>=20' ||
  !Number.isSafeInteger(controlApiProtocol) || controlApiProtocol !== 1
) throw new Error('External Orchestrator package/manifest/protocol contract is inconsistent.');

await fs.rm(stage, { recursive: true, force: true });
await fs.rm(release, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
await fs.mkdir(release, { recursive: true });

// Release packaging is self-contained: exact dev tooling comes from the committed plugin lockfile.
runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
runNpm(['run', 'build'], { cwd: root });
for (const name of REQUIRED_METADATA) await fs.copyFile(path.join(root, name), path.join(stage, name));
await fs.cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
// Unit/process tests belong to source verification, not the production connector artifact.
await fs.rm(path.join(stage, 'dist', 'test'), { recursive: true, force: true });

async function pruneBuildOnly(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await pruneBuildOnly(target);
    else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts')) await fs.rm(target, { force: true });
  }
}
await pruneBuildOnly(path.join(stage, 'dist'));

runNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
await fs.rm(path.join(stage, 'node_modules', '.package-lock.json'), { force: true });
await fs.rm(path.join(stage, 'node_modules', '.bin'), { recursive: true, force: true });

async function rejectNativeOrSymlink(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Portable MCPB refuses symlink: ${path.relative(stage, target)}`);
    if (entry.isDirectory()) await rejectNativeOrSymlink(target);
    else if (entry.isFile() && entry.name.endsWith('.node')) throw new Error(`Portable MCPB refuses native module: ${path.relative(stage, target)}`);
  }
}
await rejectNativeOrSymlink(stage);

async function auditRuntimePackageJson(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      await auditRuntimePackageJson(target);
      continue;
    }
    const packageJson = path.join(target, 'package.json');
    try {
      const runtimePackage = JSON.parse(await fs.readFile(packageJson, 'utf8'));
      if ((Array.isArray(runtimePackage.os) && runtimePackage.os.length > 0) || (Array.isArray(runtimePackage.cpu) && runtimePackage.cpu.length > 0)) {
        throw new Error(`Portable MCPB refuses platform-restricted runtime dependency: ${runtimePackage.name ?? entry.name}`);
      }
      const scripts = runtimePackage.scripts ?? {};
      if (scripts.preinstall || scripts.install || scripts.postinstall) {
        throw new Error(`Portable MCPB refuses runtime dependency with install lifecycle scripts: ${runtimePackage.name ?? entry.name}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}
await auditRuntimePackageJson(path.join(stage, 'node_modules'));
runMcpb(root, ['validate', path.join(stage, 'manifest.json')], { cwd: root });

const artifactName = `${manifest.name}-${pkg.version}.mcpb`;
const artifact = path.join(release, artifactName);
const files = await writeDeterministicZip(stage, artifact);
if (!files.includes('manifest.json') || !files.includes('dist/stdio.js')) throw new Error('Deterministic MCPB is missing required runtime files.');
if (files.some(file => file.startsWith('dist/test/'))) throw new Error('Deterministic MCPB contains build-only tests.');
runMcpb(root, ['info', artifact], { cwd: root });

const sha = createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
await fs.writeFile(path.join(release, 'SHA256SUMS'), `${sha}  ${artifactName}\n`);
await fs.writeFile(path.join(release, 'RELEASE-METADATA.json'), `${JSON.stringify({
  schema: 1,
  name: manifest.name,
  version: pkg.version,
  manifestVersion: manifest.manifest_version,
  artifact: artifactName,
  unsignedSha256: sha,
  node: '>=20',
  platforms: ['darwin', 'win32', 'linux'],
  controlApiProtocol,
}, null, 2)}\n`);
await fs.rm(stage, { recursive: true, force: true });
process.stdout.write(`MCPB ${artifact} ${sha}\n`);
