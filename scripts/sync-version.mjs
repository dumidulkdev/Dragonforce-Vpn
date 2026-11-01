import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const updates = [
  ['public/assets/js/views.js', /version: 'v[^']+'/, `version: 'v${version}'`],
  ['landing/index.html', /(?:Stable|Preview) v[0-9][0-9A-Za-z.+-]*/, `${version.includes('-') ? 'Preview' : 'Stable'} v${version}`],
  ['RELEASE.md', /DragonForce-VPN-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?=-(?:Setup|x64|arm64|ia32))/g, `DragonForce-VPN-${version}`],
];
for (const [file, pattern, replacement] of updates) {
  const target = path.join(root, file);
  const content = fs.readFileSync(target, 'utf8');
  assert.ok(pattern.test(content), `Could not find the version in ${file}`);
  fs.writeFileSync(target, content.replace(pattern, replacement));
}
console.log(`[version] Synchronized application and documentation versions to ${version}`);
