import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpb } from './package-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const artifactName = `${manifest.name}-${pkg.version}.mcpb`;
const artifact = path.join(root, 'release', artifactName);
const sums = (await fs.readFile(path.join(root, 'release', 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/u);
if (sums.length !== 1) throw new Error('External Orchestrator release must contain one checksum line.');
const [expected, name, extra] = sums[0].trim().split(/\s+/u);
if (extra !== undefined || name !== artifactName || !/^[0-9a-f]{64}$/u.test(expected ?? '')) throw new Error('Invalid MCPB checksum file.');
const actual = createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
if (actual !== expected) throw new Error(`MCPB checksum mismatch: expected ${expected}, got ${actual}`);

const metadata = JSON.parse(await fs.readFile(path.join(root, 'release', 'RELEASE-METADATA.json'), 'utf8'));
if (
  metadata.schema !== 1 || metadata.name !== manifest.name || metadata.version !== pkg.version ||
  metadata.manifestVersion !== manifest.manifest_version || metadata.artifact !== artifactName ||
  metadata.unsignedSha256 !== actual || metadata.node !== '>=20' || metadata.controlApiProtocol !== 1 ||
  JSON.stringify(metadata.platforms) !== JSON.stringify(['darwin', 'win32', 'linux'])
) throw new Error('Release metadata does not match the packaged External Orchestrator artifact.');

runMcpb(root, ['info', artifact], { cwd: root });
process.stdout.write(`External Orchestrator MCPB verified ${actual}\n`);
