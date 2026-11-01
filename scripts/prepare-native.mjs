import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = JSON.parse(await fs.readFile(path.join(root, 'scripts/native-releases.json'), 'utf8'));
const cache = path.join(root, '.release-cache');
const exec = promisify(execFile);
const machines = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function download(url, sha256) {
  const destination = path.join(cache, `${sha256}-${path.basename(new URL(url).pathname)}`);
  for (const candidate of [destination, path.join(root, 'resources/bin', path.basename(new URL(url).pathname))]) {
    try {
      if (hash(await fs.readFile(candidate)) === sha256) return candidate;
    } catch { /* Download when the verified cache is absent. */ }
  }
  console.log(`[native] Downloading ${path.basename(new URL(url).pathname)}`);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== sha256) throw new Error(`SHA-256 mismatch: ${url}`);
      await fs.writeFile(destination, bytes);
      return destination;
    } catch (error) {
      if (attempt === 3 || String(error).includes('SHA-256 mismatch')) throw error;
      console.log(`[native] Retrying download (${attempt}/3): ${error.message}`);
    }
  }
}

async function extract(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  await exec('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true });
}

async function prepareArchitecture(arch, wintunRoot, tunLicense) {
  const temporary = await fs.mkdtemp(path.join(cache, `${arch}-`));
  const destination = path.join(root, 'resources/native', arch);
  try {
    const xray = releases.xray.archives[arch];
    const tun = releases.tun2socks.archives[arch];
    const [xrayZip, tunZip] = await Promise.all([
      download(releases.xray.baseUrl + xray.name, xray.sha256),
      download(releases.tun2socks.baseUrl + tun.name, tun.sha256),
    ]);
    await Promise.all([
      extract(xrayZip, path.join(temporary, 'xray')),
      extract(tunZip, path.join(temporary, 'tun')),
    ]);
    await fs.mkdir(destination, { recursive: true });
    const files = {
      'xray.exe': path.join(temporary, 'xray/xray.exe'),
      'geoip.dat': path.join(temporary, 'xray/geoip.dat'),
      'geosite.dat': path.join(temporary, 'xray/geosite.dat'),
      'LICENSE-Xray.txt': path.join(temporary, 'xray/LICENSE'),
      'tun2socks.exe': path.join(temporary, 'tun', tun.name.replace(/\.zip$/, '.exe')),
      'LICENSE-tun2socks.txt': tunLicense,
      'wintun.dll': path.join(wintunRoot, 'wintun/bin', releases.wintun.directories[arch], 'wintun.dll'),
      'LICENSE-Wintun.txt': path.join(wintunRoot, 'wintun/LICENSE.txt'),
    };
    const checksums = {};
    for (const [name, source] of Object.entries(files)) {
      const bytes = await fs.readFile(source);
      if (/\.(exe|dll)$/.test(name)) {
        const machine = bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4);
        if (machine !== machines[arch]) throw new Error(`${arch}/${name} has the wrong CPU architecture: ${machine.toString(16)}`);
      }
      checksums[name] = hash(bytes);
      await fs.writeFile(path.join(destination, name), bytes);
    }
    await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
      architecture: arch,
      versions: { xray: releases.xray.version, tun2socks: releases.tun2socks.version, wintun: releases.wintun.version },
      archives: { xray: xray.sha256, tun2socks: tun.sha256, wintun: releases.wintun.sha256 },
      files: checksums,
    }, null, 2) + '\n');
    console.log(`[native] ${arch}: verified Xray, tun2socks, Wintun, geodata and licenses`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const architectures = args.length ? args : Object.keys(machines);
for (const arch of architectures) if (!(arch in machines)) throw new Error(`Unsupported Windows architecture: ${arch}`);
await fs.mkdir(cache, { recursive: true });
const temporary = await fs.mkdtemp(path.join(cache, 'wintun-'));
try {
  const [wintunZip, tunLicense] = await Promise.all([
    download(releases.wintun.url, releases.wintun.sha256),
    download(releases.tun2socks.license.url, releases.tun2socks.license.sha256),
  ]);
  await extract(wintunZip, temporary);
  await Promise.all(architectures.map(arch => prepareArchitecture(arch, temporary, tunLicense)));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
