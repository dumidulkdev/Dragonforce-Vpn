import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const binDir = path.join(rootDir, 'resources', 'bin');
const tmpDir = path.join(rootDir, 'resources', 'tmp');

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

async function downloadFile(url, destPath) {
  console.log(`[setup] Downloading ${url} ...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Xray-VPN-Client-Setup/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  console.log(`[setup] Saved to ${destPath} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

function extractZip(zipPath, extractTo) {
  fs.mkdirSync(extractTo, { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force`,
    ],
    { stdio: 'inherit' }
  );
}

async function ensureXray() {
  const xrayExe = path.join(binDir, 'xray.exe');
  if (fs.existsSync(xrayExe)) {
    console.log('[setup] xray.exe already exists, skipping.');
    return;
  }
  const zipPath = path.join(tmpDir, 'Xray-windows-64.zip');
  const extractDir = path.join(tmpDir, 'xray');
  await downloadFile(
    'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip',
    zipPath
  );
  extractZip(zipPath, extractDir);

  for (const file of ['xray.exe', 'geoip.dat', 'geosite.dat']) {
    const src = path.join(extractDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(binDir, file));
      console.log(`[setup] Installed ${file}`);
    }
  }
}

async function ensureTun2Socks() {
  const tunExe = path.join(binDir, 'tun2socks.exe');
  if (fs.existsSync(tunExe)) {
    console.log('[setup] tun2socks.exe already exists, skipping.');
    return;
  }
  const zipPath = path.join(tmpDir, 'tun2socks-windows-amd64.zip');
  const extractDir = path.join(tmpDir, 'tun2socks');
  await downloadFile(
    'https://github.com/xjasonlyu/tun2socks/releases/latest/download/tun2socks-windows-amd64.zip',
    zipPath
  );
  extractZip(zipPath, extractDir);

  const extractedExe = path.join(extractDir, 'tun2socks-windows-amd64.exe');
  if (fs.existsSync(extractedExe)) {
    fs.copyFileSync(extractedExe, tunExe);
    console.log('[setup] Installed tun2socks.exe');
  } else {
    const files = fs.readdirSync(extractDir);
    const exe = files.find((f) => f.endsWith('.exe'));
    if (exe) {
      fs.copyFileSync(path.join(extractDir, exe), tunExe);
      console.log('[setup] Installed tun2socks.exe');
    } else {
      throw new Error('Could not find tun2socks executable in archive');
    }
  }
}

async function ensureWintun() {
  const wintunDll = path.join(binDir, 'wintun.dll');
  if (fs.existsSync(wintunDll)) {
    console.log('[setup] wintun.dll already exists, skipping.');
    return;
  }
  const zipPath = path.join(tmpDir, 'wintun.zip');
  const extractDir = path.join(tmpDir, 'wintun');
  await downloadFile('https://www.wintun.net/builds/wintun-0.14.1.zip', zipPath);
  extractZip(zipPath, extractDir);

  const dllSrc = path.join(extractDir, 'wintun', 'bin', 'amd64', 'wintun.dll');
  if (fs.existsSync(dllSrc)) {
    fs.copyFileSync(dllSrc, wintunDll);
    console.log('[setup] Installed wintun.dll');
  } else {
    throw new Error('Could not find amd64 wintun.dll in archive');
  }
}

async function main() {
  try {
    await ensureXray();
    await ensureTun2Socks();
    await ensureWintun();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('\n[setup] All native binaries (xray.exe, tun2socks.exe, wintun.dll) are ready in resources/bin!');
  } catch (err) {
    console.error('[setup] Error setting up binaries:', err);
    process.exitCode = 1;
  }
}

main();
