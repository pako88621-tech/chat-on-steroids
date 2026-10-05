import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function npmCliCandidates({
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const execDir = pathApi.dirname(execPath);
  const inheritedPath = env.PATH ?? env.Path ?? env.path ?? '';
  const pathEntries = inheritedPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const fromEnvironment = typeof env.npm_execpath === 'string' && /(?:^|[\\/])npm-cli\.js$/i.test(env.npm_execpath)
    ? [env.npm_execpath]
    : [];
  return [...new Set([
    ...fromEnvironment,
    pathApi.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(pathApi.dirname(execDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(pathApi.dirname(execDir), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...pathEntries.flatMap(directory => [
      pathApi.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.join(pathApi.dirname(directory), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]),
  ])];
}

function resolveNpmCli(options = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = npmCliCandidates(options);
  const cli = candidates.find(candidate => exists(candidate));
  if (cli) return cli;
  throw new Error(`Could not resolve npm-cli.js for packaging. Checked: ${candidates.join(', ')}`);
}

export function runPackageCommand(command, args, {
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(command, args, { cwd, env, stdio: 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? 'unknown'}`);
}

export function runNpm(args, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  runPackageCommand(execPath, [resolveNpmCli({ ...options, execPath }), ...args], options);
}

export function mcpbCli(root) {
  return path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
}

export function runMcpb(root, args, options = {}) {
  runPackageCommand(options.execPath ?? process.execPath, [mcpbCli(root), ...args], options);
}
