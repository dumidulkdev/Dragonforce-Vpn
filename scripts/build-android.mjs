import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const androidDir = path.join(rootDir, 'apps', 'android');
const releaseDir = path.join(rootDir, 'release');

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
  const version = pkg.version;

  console.log(`[android-build] Building DragonForce VPN Android v${version}...`);

  // 1. Bundle the latest Android WebView bridge (`public/assets/js/android-bridge.js`)
  execFileSync(process.execPath, [path.join(__dirname, 'build-electron.mjs')], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  // 2. Sync shared `public/` assets into `apps/android/app/src/main/assets`
  const androidAssetsDir = path.join(androidDir, 'app', 'src', 'main', 'assets');
  copyRecursive(path.join(rootDir, 'public'), androidAssetsDir);
  console.log(`[android-build] Synced web UI assets to ${androidAssetsDir}`);

  // 3. Check if Android SDK is installed on this machine
  const sdkRoot =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')
      : path.join(process.env.HOME || '', 'Android', 'Sdk'));

  if (!sdkRoot || !fs.existsSync(sdkRoot)) {
    console.log(
      '[android-build] Android WebView assets and native bridge are synced and ready in apps/android.'
    );
    console.log(
      '[android-build] Note: ANDROID_HOME / Android SDK was not found locally. Open apps/android in Android Studio or run the GitHub Actions "Android APK Build & Release" workflow to compile APKs.'
    );
    return;
  }

  // 4. Download Android Xray binaries if not present
  execFileSync(process.execPath, [path.join(__dirname, 'download-android-binaries.mjs')], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  // 5. Run Gradle assembleRelease
  const gradleCmd = process.platform === 'win32' ? 'gradle.bat' : 'gradle';
  execFileSync(gradleCmd, ['assembleRelease', '--no-daemon'], {
    cwd: androidDir,
    stdio: 'inherit',
    env: { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
  });

  // 6. Collect output APKs into `release/`
  fs.mkdirSync(releaseDir, { recursive: true });
  const apkOutDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
  const mapping = [
    ['app-arm64-v8a-release.apk', `DragonForce-VPN-${version}-android-arm64-v8a.apk`],
    ['app-x86_64-release.apk', `DragonForce-VPN-${version}-android-x86_64.apk`],
    ['app-universal-release.apk', `DragonForce-VPN-${version}-android-universal.apk`],
  ];

  const checksumLines = [];
  for (const [srcName, destName] of mapping) {
    const srcApk = path.join(apkOutDir, srcName);
    if (fs.existsSync(srcApk)) {
      const destApk = path.join(releaseDir, destName);
      fs.copyFileSync(srcApk, destApk);
      const sum = sha256File(destApk);
      checksumLines.push(`${sum}  ${destName}`);
      console.log(`[android-build] Packaged ${destName} (${sum.slice(0, 12)}...)`);
    }
  }

  if (checksumLines.length > 0) {
    fs.writeFileSync(
      path.join(releaseDir, 'SHA256SUMS-android.txt'),
      checksumLines.join('\n') + '\n',
      'utf-8'
    );
  }
}

main().catch((err) => {
  console.error('[android-build] Build failed:', err);
  process.exitCode = 1;
});
