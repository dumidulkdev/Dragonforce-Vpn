import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tag = process.argv[2] || `v${pkg.version}`;
const destination = path.resolve(process.argv[3] || path.join(root, 'release/RELEASE-NOTES.md'));

assert.match(tag, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Use a version tag such as v2.4.1');
assert.equal(tag, `v${pkg.version}`, 'The tag must match package.json');
assert.equal(lock.version, pkg.version, 'The lockfile version must match package.json');
assert.equal(lock.packages[''].version, pkg.version, 'The lockfile root version must match package.json');
assert.equal(read('public/assets/js/views.js').match(/version: '(v[^']+)'/)?.[1], tag, 'Run npm run version to synchronize the dashboard version');

const changelog = read('CHANGELOG.md');
const sections = [...changelog.matchAll(/^## \[([^\]]+)\].*$/gm)];
const index = sections.findIndex(section => section[1] === pkg.version);
assert.ok(index >= 0, `Add release notes for ${pkg.version} to CHANGELOG.md`);
const section = sections[index];
const changes = changelog.slice(section.index + section[0].length, sections[index + 1]?.index).trim();
assert.ok(changes, 'Release notes must not be empty');

const repository = process.env.GITHUB_REPOSITORY || pkg.repository?.url?.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const files = [
  [`DragonForce-VPN-${pkg.version}-Setup.exe`, 'Recommended: automatic x64 / ARM64 / x86 selection'],
  [`DragonForce-VPN-${pkg.version}-x64-Portable.exe`, 'Intel/AMD 64-bit Windows'],
  [`DragonForce-VPN-${pkg.version}-arm64-Portable.exe`, 'ARM64 Windows, including Snapdragon PCs'],
  [`DragonForce-VPN-${pkg.version}-ia32-Portable.exe`, '32-bit x86 Windows'],
];
const rows = files.map(([file, description]) => {
  const link = repository ? `[${file}](https://github.com/${repository}/releases/download/${tag}/${file})` : `\`${file}\``;
  return `| ${link} | ${description} |`;
});
const notes = `${changes}

## Windows downloads

| File | Choose it for |
| --- | --- |
${rows.join('\n')}

Requires Windows 10 or 11 with a matching architecture. Node.js is not required.
Import your own VLESS/VMess link, subscription, or QR code, select a server, and connect.
Full TUN mode uses **Settings → Restart as administrator**.

\`SHA256SUMS.txt\` contains the executable checksums, \`BUILD-INFO.json\` records the bundled component versions, and \`README.txt\` includes installation and data-location details.

**Built by DragonForce. Contributors are welcome.**
`;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, notes);
console.log(`[release] Validated ${tag}; wrote ${destination}`);
