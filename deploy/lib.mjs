import { spawnSync } from 'node:child_process';
import { closeSync, openSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

// Arguments are passed directly to Docker; no host shell or text redirection.
export function docker(args, { inputFile, outputFile, capture = false } = {}) {
  const descriptors = [];
  try {
    const input = inputFile ? openSync(inputFile, 'r') : 'inherit';
    if (typeof input === 'number') descriptors.push(input);
    const output = outputFile ? openSync(outputFile, 'wx', 0o600) : capture ? 'pipe' : 'inherit';
    if (typeof output === 'number') descriptors.push(output);
    const result = spawnSync('docker', args, {
      cwd: root,
      stdio: [input, output, capture ? 'pipe' : 'inherit'],
      encoding: capture ? 'utf8' : undefined,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw new Error(`Docker could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Docker command failed (${result.status}). ${capture ? (result.stderr || '').trim() : 'See Docker output above.'}`);
    return capture ? result.stdout : '';
  } finally {
    for (const fd of descriptors) closeSync(fd);
  }
}

export function compose(args, options) {
  return docker(['compose', '--ansi', 'never', '--project-directory', root, ...args], options);
}

export function config() {
  // Do not print this result: the resolved configuration contains credentials.
  return JSON.parse(compose(['config', '--format', 'json'], { capture: true }));
}

export async function checksum(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

export function dbCommand(database, program, args = [], options) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error('Database name must contain lowercase letters, digits and underscores, start with a letter, and be at most 63 characters.');
  return compose(['exec', '-T', 'db', program, '-U', 'postgres', '-d', database, ...args], options);
}
