import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createAndroidBridgeController,
  type NativeAndroidBridge,
  type StorageLike,
} from '../src/android/android-bridge.ts';

function createMockNativeBridge() {
  let connected = false;
  let sessionUp = 0;
  let sessionDown = 0;
  let lastConnectPayload: Record<string, any> | null = null;
  let pendingAccessLog = '';
  const notifications: Array<Record<string, any>> = [];

  const storageMap = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (k) => storageMap.get(k) ?? null,
    setItem: (k, v) => {
      storageMap.set(k, v);
    },
  };

  const native: NativeAndroidBridge = {
    getStatus: () =>
      JSON.stringify({
        connected,
        connecting: false,
        activeServerId: lastConnectPayload?.serverId || null,
        connectedAt: connected ? 1700000000000 : null,
        lastError: null,
        socksPort: 10808,
        httpPort: 10809,
        stats: {
          upSpeed: connected ? 12000 : 0,
          downSpeed: connected ? 64000 : 0,
          sessionUp,
          sessionDown,
        },
      }),
    connect: (payloadJson) => {
      lastConnectPayload = JSON.parse(payloadJson);
      connected = true;
      return JSON.stringify({ ok: true });
    },
    disconnect: () => {
      connected = false;
      return JSON.stringify({ ok: true });
    },
    pingServer: () =>
      JSON.stringify({
        ping: 42,
        pingStatus: 'ok',
        pingCheckedAt: Date.now(),
      }),
    fetchCertSha256: () =>
      JSON.stringify({
        ok: true,
        sha256: 'a'.repeat(64),
      }),
    listInstalledApps: () =>
      JSON.stringify({
        ok: true,
        apps: [
          { packageName: 'com.whatsapp', name: 'WhatsApp', isSystem: false },
          { packageName: 'lk.combank.digital', name: 'ComBank Digital', isSystem: false },
        ],
      }),
    getDynamicColors: () =>
      JSON.stringify({
        supported: true,
        accentHex: '#F43F5E',
        accentSoftHex: '#4C0519',
      }),
    dispatchNotification: (payloadJson) => {
      notifications.push(JSON.parse(payloadJson));
      return JSON.stringify({ ok: true });
    },
    readClipboard: () => JSON.stringify({ ok: true, text: 'vless://clip' }),
    writeClipboard: () => JSON.stringify({ ok: true }),
    shareText: () => JSON.stringify({ ok: true }),
    getLogs: () => JSON.stringify([]),
    clearLogs: () => JSON.stringify({ ok: true }),
    drainAccessLog: () => {
      const out = pendingAccessLog;
      pendingAccessLog = '';
      return out;
    },
  };

  return {
    native,
    storage,
    notifications,
    getLastConnectPayload: () => lastConnectPayload,
    setTraffic: (up: number, down: number) => {
      sessionUp = up;
      sessionDown = down;
    },
    pushAccessLog: (chunk: string) => {
      pendingAccessLog += chunk;
    },
    isConnected: () => connected,
  };
}

test('Android bridge controller imports servers, pins TLS cert, applies Per-App Split Tunneling, and connects', async () => {
  const mock = createMockNativeBridge();
  const ctrl = createAndroidBridgeController(mock.native, mock.storage);

  const initRes = await ctrl.handleApi('/api/init');
  assert.equal(initRes.platform, 'android');
  assert.equal(initRes.installedApps.length, 2);
  assert.equal(initRes.dynamicColors.supported, true);

  const importRes = await ctrl.handleApi('/api/import-links', {
    rawText:
      'vless://b831381d-6324-4d53-ad4f-8cda48b30811@sg.dragonforce.example:443?security=tls&type=ws&path=%2Fws&allowInsecure=1#Singapore-Node',
  });
  assert.equal(importRes.importedCount, 1);

  // Configure Android Per-App Split Tunneling
  const splitRes = await ctrl.handleApi('/api/split-tunnel/config', {
    perAppMode: 'bypass_selected',
    toggleApp: 'lk.combank.digital',
  });
  assert.equal(splitRes.splitTunnel.perAppMode, 'bypass_selected');
  assert.deepEqual(splitRes.splitTunnel.selectedApps, ['lk.combank.digital']);

  // Connect VPN
  const connRes = await ctrl.handleApi('/api/connect', {});
  assert.equal(connRes.ok, true);
  assert.equal(mock.isConnected(), true);

  const payload = mock.getLastConnectPayload();
  assert.ok(payload);
  assert.equal(payload.perAppMode, 'bypass_selected');
  assert.deepEqual(payload.selectedApps, ['lk.combank.digital']);
  assert.ok(
    payload.xrayConfigJson.includes('a'.repeat(64)),
    'Expected leaf TLS cert SHA-256 to be pinned in Xray config'
  );
});

test('Android bridge controller dispatches Data Cap 80%/100% and Privacy Shield milestone notifications', async () => {
  const mock = createMockNativeBridge();
  const ctrl = createAndroidBridgeController(mock.native, mock.storage);

  await ctrl.handleApi('/api/import-links', {
    rawText:
      'vless://b831381d-6324-4d53-ad4f-8cda48b30811@sg.dragonforce.example:443?security=tls&type=tcp#Node1',
  });
  await ctrl.handleApi('/api/connect', {});

  // Set a 1,000-byte daily data cap with 80% warning and autoDisconnect=true
  await ctrl.handleApi('/api/usage/datacap', {
    enabled: true,
    period: 'daily',
    limitBytes: 1000,
    alertPct: 80,
    autoDisconnect: true,
  });

  // 1. Simulate 850 bytes used (85% -> triggers 80% warning notification)
  mock.setTraffic(250, 600);
  ctrl.pollTelemetryTick();
  assert.equal(
    mock.notifications.some((n) => n.title.includes('Data Cap Warning (85%)')),
    true,
    'Should emit 80% data cap warning notification'
  );
  assert.equal(mock.isConnected(), true);

  // 2. Simulate 1,100 bytes used (110% -> triggers 100% limit notification + auto-disconnect)
  mock.setTraffic(400, 700);
  ctrl.pollTelemetryTick();
  assert.equal(
    mock.notifications.some((n) => n.title.includes('Data Cap Reached (100%)')),
    true,
    'Should emit 100% data cap reached notification'
  );
  assert.equal(mock.isConnected(), false, 'Should auto-disconnect when 100% data cap is reached');

  // 3. Simulate 100 Ad Shield blocked log lines -> triggers Privacy Shield Milestone notification
  const lines = Array.from({ length: 100 }, (_, i) =>
    `2026/11/04 12:00:00 from 127.0.0.1:${50000 + i} accepted tcp:ads.youtube.com:443 [socks-in -> adblock]`
  ).join('\n');
  mock.pushAccessLog(lines);
  ctrl.pollTelemetryTick();
  assert.equal(
    mock.notifications.some((n) => n.title.includes('Privacy Shield Milestone')),
    true,
    'Should emit Privacy Shield Milestone notification at 100 blocked requests'
  );
});

test('Responsive mobile UI, Material You theme, and Per-App Split Tunneling UI are present', () => {
  const html = fs.readFileSync(path.resolve('public/app.html'), 'utf-8');
  assert.ok(html.includes('viewport-fit=cover'), 'app.html includes viewport-fit=cover');
  assert.ok(html.includes('/assets/js/android-bridge.js'), 'app.html loads android-bridge.js');

  const css = fs.readFileSync(path.resolve('public/assets/css/app.css'), 'utf-8');
  assert.ok(css.includes('@media (max-width: 768px)'), 'app.css includes phone responsive breakpoint');
  assert.ok(css.includes('env(safe-area-inset-bottom'), 'app.css handles Android gesture bar safe area');
  assert.ok(css.includes('data-material-you="true"'), 'app.css includes Material You theme rules');

  const splitJs = fs.readFileSync(path.resolve('public/assets/js/split-tunnel.js'), 'utf-8');
  assert.ok(splitJs.includes('st-per-app-mode'), 'split-tunnel.js renders Per-App mode selector');
  assert.ok(splitJs.includes('st-toggle-app'), 'split-tunnel.js renders Per-App toggle switches');

  const viewsJs = fs.readFileSync(path.resolve('public/assets/js/views.js'), 'utf-8');
  assert.ok(viewsJs.includes('material_you'), 'views.js includes Material You theme button');
  assert.ok(viewsJs.includes('Notifications &amp; Android Alerts'), 'views.js includes Android notification settings');
});
