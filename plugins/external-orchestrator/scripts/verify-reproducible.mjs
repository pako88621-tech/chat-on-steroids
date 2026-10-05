import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const artifact = path.join(root, 'release', `${manifest.name}-${pkg.version}.mcpb`);
const script = path.join(root, 'scripts', 'package-mcpb.mjs');

function packageOnce() {
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`package-mcpb.mjs exited with status ${result.status ?? 'unknown'}`);
}

async function digest() {
  return createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
}

packageOnce();
const first = await digest();
packageOnce();
const second = await digest();
if (first !== second) throw new Error(`Unsigned External Orchestrator MCPB is not reproducible: ${first} != ${second}`);
process.stdout.write(`Unsigned External Orchestrator MCPB reproducibility verified: ${second}\n`);
