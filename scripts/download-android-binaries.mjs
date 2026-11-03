import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const androidAppDir = path.join(rootDir, 'apps', 'android', 'app', 'src', 'main');
const jniLibsDir = path.join(androidAppDir, 'jniLibs');
const assetsDir = path.join(androidAppDir, 'assets');
const tmpDir = path.join(rootDir, 'resources', 'tmp-android');

const XRAY_VERSION = 'v26.1.31';

const ABIS = [
  {
    abi: 'arm64-v8a',
    xrayZip: 'Xray-android-arm64-v8a.zip',
  },
  {
    abi: 'x86_64',
    xrayZip: 'Xray-linux-64.zip',
  },
];

async function downloadFile(url, destPath) {
  console.log(`[android-bins] Downloading ${url} ...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DragonForce-VPN-Android-Setup/2.4.1' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  console.log(`[android-bins] Saved ${destPath} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}

function extractZip(zipPath, extractTo) {
  fs.mkdirSync(extractTo, { recursive: true });
  if (process.platform === 'win32') {
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
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', extractTo], { stdio: 'inherit' });
  }
}

async function main() {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  for (const target of ABIS) {
    const abiDir = path.join(jniLibsDir, target.abi);
    fs.mkdirSync(abiDir, { recursive: true });
    const libxrayPath = path.join(abiDir, 'libxray.so');
    if (fs.existsSync(libxrayPath)) {
      console.log(`[android-bins] ${target.abi}/libxray.so already exists, skipping.`);
      continue;
    }

    const zipPath = path.join(tmpDir, target.xrayZip);
    const extractDir = path.join(tmpDir, target.abi);
    const url = `https://github.com/XTLS/Xray-core/releases/latest/download/${target.xrayZip}`;

    await downloadFile(url, zipPath);
    extractZip(zipPath, extractDir);

    const xrayBin = path.join(extractDir, 'xray');
    if (fs.existsSync(xrayBin)) {
      fs.copyFileSync(xrayBin, libxrayPath);
      fs.chmodSync(libxrayPath, 0o755);
      console.log(`[android-bins] Installed ${target.abi}/libxray.so`);
    }

    for (const dat of ['geoip.dat', 'geosite.dat']) {
      const datSrc = path.join(extractDir, dat);
      const datDst = path.join(assetsDir, dat);
      if (fs.existsSync(datSrc) && !fs.existsSync(datDst)) {
        fs.copyFileSync(datSrc, datDst);
        console.log(`[android-bins] Installed assets/${dat}`);
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[android-bins] Android native binaries ready (${XRAY_VERSION}).`);
}

main().catch((err) => {
  console.error('[android-bins] Failed to prepare Android binaries:', err);
  process.exitCode = 1;
});
