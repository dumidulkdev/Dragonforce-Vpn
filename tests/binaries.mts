import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { resolveNativeBinaries } from '../src/main/binaries.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dragonforce-binaries-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function file(filePath: string, executable = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fixture');
  fs.chmodSync(filePath, executable ? 0o755 : 0o644);
}

await test('Windows resolution preserves bundled executable and DLL names', () => {
  const bin = path.join(root, 'windows');
  for (const name of ['xray.exe', 'tun2socks.exe', 'wintun.dll', 'geoip.dat', 'geosite.dat']) {
    file(path.join(bin, name));
  }
  const resolved = resolveNativeBinaries({ platform: 'win32', bundledBinDir: bin, env: {} });
  assert.equal(resolved.xrayPath, path.join(bin, 'xray.exe'));
  assert.equal(resolved.tun2socksPath, path.join(bin, 'tun2socks.exe'));
  assert.equal(resolved.wintunPath, path.join(bin, 'wintun.dll'));
  assert.equal(resolved.xrayAssetDir, bin);
});

await test('Linux resolution prioritizes executable overrides, then bundled files, then PATH', () => {
  const bin = path.join(root, 'linux-bundled');
  const override = path.join(root, 'overrides', 'xray');
  const pathBin = path.join(root, 'path-bin');
  file(path.join(bin, 'xray'), true);
  file(path.join(bin, 'tun2socks'), true);
  file(override, true);
  file(path.join(pathBin, 'xray'), true);

  const overridden = resolveNativeBinaries({
    platform: 'linux',
    bundledBinDir: bin,
    env: { DRAGONFORCE_XRAY_PATH: override, PATH: pathBin },
    systemBinDirs: [],
  });
  assert.equal(overridden.xrayPath, override);
  assert.equal(overridden.tun2socksPath, path.join(bin, 'tun2socks'));

  const bundled = resolveNativeBinaries({ platform: 'linux', bundledBinDir: bin, env: { PATH: pathBin }, systemBinDirs: [] });
  assert.equal(bundled.xrayPath, path.join(bin, 'xray'));

  fs.chmodSync(path.join(bin, 'xray'), 0o644);
  const fallback = resolveNativeBinaries({ platform: 'linux', bundledBinDir: bin, env: { PATH: pathBin }, systemBinDirs: [] });
  assert.equal(fallback.xrayPath, path.join(pathBin, 'xray'));
});

await test('Linux geodata prefers a complete bundled pair and rejects non-executable binaries', () => {
  const bin = path.join(root, 'linux-assets');
  const systemAssets = path.join(root, 'system-assets');
  file(path.join(bin, 'xray'));
  file(path.join(bin, 'geoip.dat'));
  file(path.join(bin, 'geosite.dat'));
  file(path.join(systemAssets, 'geoip.dat'));
  file(path.join(systemAssets, 'geosite.dat'));

  const resolved = resolveNativeBinaries({
    platform: 'linux',
    bundledBinDir: bin,
    env: { PATH: '', XRAY_LOCATION_ASSET: systemAssets },
    systemBinDirs: [],
    systemAssetDirs: [systemAssets],
  });
  assert.equal(resolved.xrayPath, null);
  assert.equal(resolved.xrayAssetDir, bin);
  assert.equal(resolved.geoipPath, path.join(bin, 'geoip.dat'));
  assert.equal(resolved.geositePath, path.join(bin, 'geosite.dat'));
  assert.equal(resolved.wintunPath, null);

  fs.unlinkSync(path.join(bin, 'geosite.dat'));
  const fallback = resolveNativeBinaries({
    platform: 'linux',
    bundledBinDir: bin,
    env: { PATH: '' },
    systemBinDirs: [],
    systemAssetDirs: [systemAssets],
  });
  assert.equal(fallback.xrayAssetDir, systemAssets);
});
