import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('The Linux network helper must be built on Linux.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperRoot = path.join(root, 'native/linux-helper');
const output = path.join(root, 'build/linux/dragonforce-net-helper');
await fs.mkdir(path.dirname(output), { recursive: true });
await promisify(execFile)('go', [
  'build', '-trimpath', '-ldflags=-s -w', '-o', output, '.',
], { cwd: helperRoot, windowsHide: true });
await fs.chmod(output, 0o755);
console.log(`[linux] Built network helper: ${output}`);
