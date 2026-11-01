import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] || 'release');
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
const pins = JSON.parse(await fsp.readFile(path.join(root, 'scripts/native-releases.json'), 'utf8'));
const architectures = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const archiver = path.join(root, 'node_modules/electron-winstaller/vendor/7z.exe');
const archiveNames = { x64: 'app-64.7z', arm64: 'app-arm64.7z', ia32: 'app-32.7z' };

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function machine(file) {
  const handle = await fsp.open(file);
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    assert.equal(dos.toString('ascii', 0, 2), 'MZ', `${file}: missing executable header`);
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, pe.length, dos.readUInt32LE(60));
    assert.equal(pe.readUInt32LE(0), 0x4550, `${file}: missing PE header`);
    return pe.readUInt16LE(4);
  } finally { await handle.close(); }
}

const payloads = [];
for (const [arch, expected] of Object.entries(architectures)) {
  const directory = path.join(output, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);
  assert.equal(await machine(path.join(directory, 'DragonForce-VPN.exe')), expected, `${arch}: wrong Electron architecture`);
  const native = path.join(directory, 'resources/bin');
  const manifest = JSON.parse(await fsp.readFile(path.join(native, 'manifest.json'), 'utf8'));
  assert.equal(manifest.architecture, arch);
  assert.deepEqual(manifest.versions, { xray: pins.xray.version, tun2socks: pins.tun2socks.version, wintun: pins.wintun.version });
  for (const [file, checksum] of Object.entries(manifest.files)) {
    assert.equal(await fileHash(path.join(native, file)), checksum, `${arch}/${file}: hash mismatch`);
    if (/\.(exe|dll)$/.test(file)) assert.equal(await machine(path.join(native, file)), expected, `${arch}/${file}: wrong CPU architecture`);
  }
  const archive = path.join(directory, 'resources/app.asar');
  const entries = asar.listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\//, ''));
  assert.ok(entries.every(name => /^(?:node_modules|public|dist-electron|package\.json)(?:\/|$)/.test(name)), 'Unexpected application payload');
  assert.ok(!entries.some(name => /(?:^|\/)(?:vpn-state\.json|active-config\.json|xray-access\.log|\.env(?:\..*)?)$/.test(name)), 'Private runtime data must never be packaged');
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(metadata.main, 'dist-electron/desktop.cjs');
  assert.equal(metadata.version, pkg.version);
  // Verify that every dashboard asset and bundled entry is from this release's sources.
  for (const file of entries.filter(name => name.startsWith('public/') || name.startsWith('dist-electron/'))) {
    const source = path.join(root, file);
    if (!(await fsp.stat(source)).isFile()) continue;
    assert.equal(digest(asar.extractFile(archive, path.normalize(file))), await fileHash(source), `${arch}/${file}: stale release payload`);
  }
  payloads.push({
    architecture: arch, executableSha256: await fileHash(path.join(directory, 'DragonForce-VPN.exe')),
    applicationSha256: await fileHash(archive), native: manifest,
  });
  console.log(`[verify] ${arch}: correct executable architectures, native hashes, complete dashboard and clean data`);
}

const names = [
  `DragonForce-VPN-${pkg.version}-Setup.exe`,
  ...Object.keys(architectures).map(arch => `DragonForce-VPN-${pkg.version}-${arch}-Portable.exe`),
];
const artifacts = [];
for (const file of names) {
  const absolute = path.join(output, file);
  assert.equal(await machine(absolute), 0x14c, `${file}: expected the Windows-compatible NSIS launcher`);
  const expected = file.endsWith('-Setup.exe') ? Object.keys(architectures) : [file.split('-').at(-2)];
  const { stdout } = await exec(archiver, ['l', '-slt', absolute], { windowsHide: true });
  const embedded = [...stdout.matchAll(/^Path = ([^\r\n]+\.7z)\r?$/gm)].map(match => path.basename(match[1]));
  assert.deepEqual(embedded.sort(), expected.map(arch => archiveNames[arch]).sort(), `${file}: wrong embedded architectures`);
  const temporaryRoot = path.join(process.env.LOCALAPPDATA, 'Temp/opencode');
  await fsp.mkdir(temporaryRoot, { recursive: true });
  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'vpn-release-verify-'));
  try {
    await exec(archiver, ['t', '-bso0', '-bsp0', absolute], { windowsHide: true, timeout: 120000 });
    await exec(archiver, ['e', '-r', '-y', '-bso0', '-bsp0', absolute, '*.7z', `-o${temporary}`], { windowsHide: true, timeout: 120000 });
    for (const arch of expected) {
      const extracted = path.join(temporary, arch);
      await exec(archiver, [
        'e', '-y', '-bso0', '-bsp0', path.join(temporary, archiveNames[arch]),
        'DragonForce-VPN.exe', 'resources/app.asar', 'resources/bin/*', `-o${extracted}`,
      ], { windowsHide: true, timeout: 120000 });
      const payload = payloads.find(item => item.architecture === arch);
      assert.equal(await machine(path.join(extracted, 'DragonForce-VPN.exe')), architectures[arch]);
      assert.equal(await fileHash(path.join(extracted, 'DragonForce-VPN.exe')), payload.executableSha256);
      assert.equal(await fileHash(path.join(extracted, 'app.asar')), payload.applicationSha256);
      assert.deepEqual(JSON.parse(await fsp.readFile(path.join(extracted, 'manifest.json'), 'utf8')), payload.native);
      for (const [nativeFile, checksum] of Object.entries(payload.native.files)) {
        assert.equal(await fileHash(path.join(extracted, nativeFile)), checksum, `${file}/${arch}/${nativeFile}: bad embedded resource`);
      }
      await fsp.rm(extracted, { recursive: true, force: true });
    }
  } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
  console.log(`[verify] ${file}: installer integrity and actual embedded payloads passed`);
  artifacts.push({ file, bytes: (await fsp.stat(absolute)).size, sha256: await fileHash(absolute) });
}
await fsp.writeFile(path.join(output, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
await fsp.writeFile(path.join(output, 'BUILD-INFO.json'), JSON.stringify({
  name: pkg.productName, version: pkg.version, electron: pkg.devDependencies.electron,
  builder: pkg.devDependencies['electron-builder'], artifacts, payloads,
}, null, 2) + '\n');
await fsp.writeFile(path.join(output, 'README.txt'), `DragonForce VPN ${pkg.version} - Windows release

RECOMMENDED: ${names[0]}
The offline installer automatically selects x64, ARM64, or 32-bit x86.

PORTABLE EXES (no installation required):
${names[1]} - Intel/AMD 64-bit Windows
${names[2]} - ARM64 Windows, including Snapdragon PCs
${names[3]} - 32-bit x86 Windows (ia32)

Requires Windows 10 or Windows 11 with the matching OS architecture.
Windows 11 is 64-bit only. ARM32 and other CPU architectures are unsupported.
Electron, Xray, tun2socks and Wintun are included; Node.js is not required.

Start the app and import your own VLESS/VMess links or subscriptions.
Legacy 3x-ui/NetMod encoded WebSocket paths are normalized automatically.
For servers requiring allowInsecure=true, use Edit server > Security >
Allow insecure certificate, then save and reconnect.
System Proxy mode works without administrator privileges. Full-device TUN
mode requires the app's administrator relaunch or Run as administrator.
Closing the window disconnects the VPN and restores its Windows settings.

Both installed and portable builds save profiles/settings in:
%APPDATA%\\DragonForce VPN
Uninstalling retains this data. No saved VPN profiles are included in the release.
The portable launcher extracts runtime files to a temporary directory.

Bundled versions: Electron ${pkg.devDependencies.electron}, Xray ${pins.xray.version},
tun2socks ${pins.tun2socks.version}, Wintun ${pins.wintun.version}.
Third-party licenses are included with the application.
These release files are unsigned.

SHA256SUMS.txt contains checksums for the four distributable EXEs.
BUILD-INFO.json records the exact native versions and payload hashes.
`);
console.log('[verify] Wrote release README, build information and SHA-256 checksums.');
for (const item of artifacts) console.log(`${item.file}: ${(item.bytes / 1024 / 1024).toFixed(1)} MiB`);
