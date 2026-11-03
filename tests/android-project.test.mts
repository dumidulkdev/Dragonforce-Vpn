import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('Android project (apps/android) is configured with Capacitor, VpnService, Quick Tile, and Widget', () => {
  const androidRoot = path.resolve('apps/android');
  const capConfig = JSON.parse(
    fs.readFileSync(path.join(androidRoot, 'capacitor.config.json'), 'utf-8')
  );
  assert.equal(capConfig.appId, 'com.dragonforce.vpn');
  assert.equal(capConfig.appName, 'DragonForce VPN');
  assert.equal(capConfig.webDir, '../../public');

  const manifestPath = path.join(androidRoot, 'app/src/main/AndroidManifest.xml');
  const manifest = fs.readFileSync(manifestPath, 'utf-8');

  for (const perm of [
    'android.permission.INTERNET',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.CAMERA',
    'android.permission.QUERY_ALL_PACKAGES',
  ]) {
    assert.ok(manifest.includes(perm), `Manifest should declare ${perm}`);
  }

  for (const component of [
    '.MainActivity',
    '.DragonForceVpnService',
    '.VpnActionReceiver',
    '.VpnQuickTileService',
    '.VpnStatusWidgetProvider',
  ]) {
    assert.ok(manifest.includes(component), `Manifest should register ${component}`);
  }

  const kotlinDir = path.join(androidRoot, 'app/src/main/java/com/dragonforce/vpn');
  for (const file of [
    'MainActivity.kt',
    'DragonForceVpnPlugin.kt',
    'DragonForceVpnService.kt',
    'TlsCertPinner.kt',
    'NotificationHelper.kt',
    'VpnActionReceiver.kt',
    'VpnQuickTileService.kt',
    'VpnStatusWidgetProvider.kt',
  ]) {
    assert.ok(
      fs.existsSync(path.join(kotlinDir, file)),
      `Expected Kotlin file ${file} to exist`
    );
  }

  const serviceSrc = fs.readFileSync(path.join(kotlinDir, 'DragonForceVpnService.kt'), 'utf-8');
  assert.ok(serviceSrc.includes('addDisallowedApplication'), 'Supports per-app bypass split tunneling');
  assert.ok(serviceSrc.includes('addAllowedApplication'), 'Supports per-app VPN-only split tunneling');
  assert.ok(serviceSrc.includes('198.18.0.1'), 'Configures FakeDNS TUN address');
});
