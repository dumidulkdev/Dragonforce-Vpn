import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseShareLink, parseMultipleLinks } from '../src/main/parser.ts';
import { generateXrayConfig } from '../src/main/xrayConfig.ts';
import { resolveNativeBinaries } from '../src/main/binaries.ts';

console.log('--- Running Xray VPN Client Verification Suite ---');

// 1. Test VLESS + TLS + WS link parsing
const vlessWsTlsUri =
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@cdn.example.com:443?encryption=none&security=tls&sni=sni.example.com&fp=chrome&alpn=h2%2Chttp%2F1.1&type=ws&host=ws.example.com&path=%2Fgraphql#US-Cloudflare-VLESS';

const vlessNode = parseShareLink(vlessWsTlsUri);
assert.equal(vlessNode.protocol, 'vless');
assert.equal(vlessNode.address, 'cdn.example.com');
assert.equal(vlessNode.port, 443);
assert.equal(vlessNode.uuid, 'b831381d-6324-4d53-ad4f-8cda48b30811');
assert.equal(vlessNode.network, 'ws');
assert.equal(vlessNode.security, 'tls');
assert.equal(vlessNode.sni, 'sni.example.com');
assert.equal(vlessNode.host, 'ws.example.com');
assert.equal(vlessNode.path, '/graphql');
assert.deepEqual(vlessNode.alpn, ['h2', 'http/1.1']);
assert.equal(vlessNode.name, 'US-Cloudflare-VLESS');
console.log('[PASS] VLESS + TLS + WS parser');

// 2. Test VMess + TLS + TCP/WS Base64 JSON link parsing
const vmessJsonObj = {
  v: '2',
  ps: 'SG-VMess-TLS-Node',
  add: 'sg.example.org',
  port: '8443',
  id: '27848739-7e62-4138-9fd3-098a63964b6b',
  aid: '0',
  scy: 'auto',
  net: 'ws',
  type: 'none',
  host: 'sg.example.org',
  path: '/vmess-ws',
  tls: 'tls',
  sni: 'sg.example.org',
  alpn: 'http/1.1',
  fp: 'firefox',
};
const vmessUri = `vmess://${Buffer.from(JSON.stringify(vmessJsonObj)).toString('base64')}`;
const vmessNode = parseShareLink(vmessUri);
assert.equal(vmessNode.protocol, 'vmess');
assert.equal(vmessNode.name, 'SG-VMess-TLS-Node');
assert.equal(vmessNode.address, 'sg.example.org');
assert.equal(vmessNode.port, 8443);
assert.equal(vmessNode.network, 'ws');
assert.equal(vmessNode.security, 'tls');
assert.equal(vmessNode.path, '/vmess-ws');
console.log('[PASS] VMess + TLS + WS parser');

// 3. Test Base64 Subscription Payload parsing
const subPayload = Buffer.from(`${vlessWsTlsUri}\n${vmessUri}`, 'utf-8').toString('base64');
const subParsed = parseMultipleLinks(subPayload, 'sub-1');
assert.equal(subParsed.nodes.length, 2);
assert.equal(subParsed.errors.length, 0);
console.log('[PASS] Base64 Subscription multi-link parser');

// Regression: flow=none must work for new imports and previously saved TCP profiles.
const vlessTcpTlsUri =
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@vpn.example.com:443?encryption=none&security=tls&type=tcp';
const vlessTcpNode = parseShareLink(vlessTcpTlsUri);
const noFlowConfig = generateXrayConfig(vlessTcpNode, { tunMode: true, mux: true });
for (const flow of ['', 'none', ' NONE ', ' \t ']) {
  const imported = parseShareLink(`${vlessTcpTlsUri}&flow=${encodeURIComponent(flow)}`);
  assert.equal(imported.flow, undefined, 'empty/none flow must be normalized on import');
  for (const node of [imported, { ...vlessTcpNode, flow }]) {
    assert.deepEqual(
      generateXrayConfig(node, { tunMode: true, mux: true }),
      noFlowConfig,
      'imported and saved no-flow profiles must behave like a profile with flow omitted'
    );
  }
}
const vlessFlowNoneNode = parseShareLink(`${vlessTcpTlsUri}&flow=none`);
const savedFlowNoneNode = { ...vlessTcpNode, flow: 'none' };
const visionNodes = ['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].map((flow) => {
  const node = parseShareLink(`${vlessTcpTlsUri}&flow=${flow}`);
  assert.equal(node.flow, flow, 'Vision flow must survive import');
  const outbound = (generateXrayConfig(node, { mux: true }).outbounds as any[])[0];
  assert.equal(outbound.settings.vnext[0].users[0].flow, flow, 'Vision flow must reach Xray');
  assert.equal(outbound.mux, undefined, 'Vision must keep multiplexing disabled');
  return node;
});
console.log('[PASS] VLESS no-flow import/saved-profile compatibility and Vision preservation');

// 4. Test Xray Config Generator & Xray-core native config validation (`xray run -test`)
const nativeBinaries = resolveNativeBinaries({
  bundledBinDir: path.resolve(process.env.VPN_BIN_DIR || 'resources/bin'),
});
const xrayBin = nativeBinaries.xrayPath;
function validateWithXray(configPath: string): string | null {
  if (!xrayBin) return null;
  const assetEnv = nativeBinaries.xrayAssetDir
    ? { ...process.env, XRAY_LOCATION_ASSET: nativeBinaries.xrayAssetDir }
    : undefined;
  return execFileSync(xrayBin, ['run', '-test', '-c', configPath], {
    cwd: path.dirname(xrayBin),
    encoding: 'utf-8',
    env: assetEnv,
  });
}
const tempRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA!, 'Temp', 'opencode') : os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const configDir = fs.mkdtempSync(path.join(tempRoot, 'vpn-config-tests-'));
after(() => fs.rmSync(configDir, { recursive: true, force: true }));
if (xrayBin) {
  const tmpCfgPath = path.join(configDir, 'test-verify-config.json');
  for (const node of [vlessNode, vmessNode, vlessFlowNoneNode, savedFlowNoneNode, ...visionNodes]) {
    const cfg = generateXrayConfig(node, { socksPort: 10808, httpPort: 10809 });
    fs.writeFileSync(tmpCfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    const out = validateWithXray(tmpCfgPath)!;
    assert.ok(out.includes('Configuration OK'), `Xray config test failed: ${out}`);
    console.log(`[PASS] Xray run -test validated ${node.protocol.toUpperCase()} config`);
  }
  fs.rmSync(tmpCfgPath, { force: true });
} else {
  console.log('[INFO] A native Xray executable is unavailable; skipping native config checks');
}

// 5. World map geometry (shared with the browser UI)
{
  const { applyServerEdit, toShareLink } = await import('../src/main/serverEdit.ts');

  // Edit SNI/host/remarks on a VLESS node and round-trip through the share link.
  const edited = applyServerEdit(vlessNode, { name: 'SG Edited', sni: 'aka.ms', host: 'cdn.example.net', path: '/new', alpn: 'h2' });
  const reparsed = parseShareLink(toShareLink(edited));
  assert.equal(reparsed.name, 'SG Edited');
  assert.equal(reparsed.sni, 'aka.ms');
  assert.equal(reparsed.host, 'cdn.example.net');
  assert.equal(reparsed.path, '/new');
  assert.deepEqual(reparsed.alpn, ['h2']);
  assert.equal(reparsed.uuid, vlessNode.uuid);
  assert.equal(reparsed.network, 'ws');
  assert.equal(reparsed.security, 'tls');
  console.log('[PASS] VLESS edit + share-link round-trip');

  // VMess edit round-trip, including switching transport.
  const vm = applyServerEdit(vmessNode, { network: 'tcp', headerType: 'none', sni: 'edited.example.org', port: '2053', cipher: 'aes-128-gcm' });
  const vmBack = parseShareLink(toShareLink(vm));
  assert.equal(vmBack.network, 'tcp');
  assert.equal(vmBack.port, 2053);
  assert.equal(vmBack.sni, 'edited.example.org');
  assert.equal(vmBack.cipher, 'aes-128-gcm');
  assert.equal(vmBack.name, vmessNode.name);
  console.log('[PASS] VMess edit + share-link round-trip');

  // Edited node still produces a config Xray accepts.
  if (xrayBin) {
    const tmp = path.join(configDir, 'test-edit-config.json');
    fs.writeFileSync(tmp, JSON.stringify(generateXrayConfig(edited, {})), 'utf-8');
    assert.ok(validateWithXray(tmp)!.includes('Configuration OK'));
    fs.rmSync(tmp, { force: true });
    console.log('[PASS] Xray accepts edited config');
  }

  // Validation rejects bad input with readable messages.
  assert.throws(() => applyServerEdit(vlessNode, { port: 70000 }), /Port/);
  assert.throws(() => applyServerEdit(vlessNode, { name: '  ' }), /Remarks/);
  assert.throws(() => applyServerEdit(vlessNode, { address: 'bad host/x' }), /address/);
  assert.throws(() => applyServerEdit(vlessNode, { security: 'reality', publicKey: '' }), /public key/);
  assert.throws(() => applyServerEdit(vlessNode, { network: 'quic' }), /transport/);
  console.log('[PASS] Edit validation');

  // Regression: Xray ≥ 26 rejects any config containing `allowInsecure`.
  const insecureNode = { ...vlessNode, allowInsecure: true };
  const insecureCfg = generateXrayConfig(insecureNode, { pinnedCertSha256: 'ab'.repeat(32) });
  const insecureJson = JSON.stringify(insecureCfg);
  assert.ok(!insecureJson.includes('allowInsecure'), 'generated config must never contain allowInsecure');
  assert.ok(insecureJson.includes('pinnedPeerCertSha256'));
  assert.ok(!JSON.stringify(generateXrayConfig(vlessNode, { pinnedCertSha256: 'ab'.repeat(32) })).includes('pinnedPeerCertSha256'), 'pin only applies when allow-insecure is on');
  assert.ok(!JSON.stringify(generateXrayConfig(vlessNode, { allowInsecureDefault: true })).includes('allowInsecure'));
  if (xrayBin) {
    const tmp = path.join(configDir, 'test-insecure-config.json');
    fs.writeFileSync(tmp, insecureJson, 'utf-8');
    assert.ok(validateWithXray(tmp)!.includes('Configuration OK'));
    fs.rmSync(tmp, { force: true });
  }
  // Regression: TUN mode DNS hijack + fast HTTP CONNECT (sniffing off on http-in) + optional Mux must pass Xray validation.
  const tunCfg = generateXrayConfig(vlessNode, { tunMode: true, mux: false });
  const tunJson = JSON.stringify(tunCfg);
  assert.ok(tunJson.includes('dns-out'), 'TUN config must hijack port 53 to dns-out');
  assert.ok(!tunJson.includes('xudpConcurrency'), 'Mux must be off by default');
  assert.equal((tunCfg.inbounds as any[])[1].sniffing.enabled, false, 'http-in must disable sniffing for zero-delay CONNECT');
  if (xrayBin) {
    const tmp = path.join(configDir, 'test-tun-mux-config.json');
    fs.writeFileSync(tmp, tunJson, 'utf-8');
    assert.ok(validateWithXray(tmp)!.includes('Configuration OK'));
    fs.rmSync(tmp, { force: true });
  }
  console.log(`[PASS] TUN DNS hijack + zero-delay HTTP CONNECT config${xrayBin ? ' validated by Xray' : ' generated'}`);
}

// 6. World map geometry (shared with the browser UI)
const geoMath = await import('../public/assets/js/geo-math.js');
{
  const W = 800;
  const H = 600;
  const view = { lon: 90, lat: 5, k: 2 };
  const colombo = { lon: 79.86, lat: 6.93 };
  const p = geoMath.project(view, W, H, colombo.lon, colombo.lat);
  const back = geoMath.unproject(view, W, H, p.x, p.y);
  assert.ok(Math.abs(back.lon - colombo.lon) < 1e-9 && Math.abs(back.lat - colombo.lat) < 1e-9);
  console.log('[PASS] Map projection round-trip');

  // Date line: Tokyo -> Los Angeles must take the short (Pacific) way, i.e. go east past 180°.
  assert.equal(geoMath.normalizeLon(190), -170);
  const la = geoMath.nearestLon(-118.24, 139.69);
  assert.ok(la > 180 && la < 260, `expected unwrapped LA longitude, got ${la}`);
  console.log('[PASS] Date-line safe route longitude');

  // Zoom keeps the point under the cursor fixed.
  const z = geoMath.zoomAt({ lon: 0, lat: 0, k: 1.5 }, W, H, 200, 250, 2);
  const before = geoMath.unproject({ lon: 0, lat: 0, k: 1.5 }, W, H, 200, 250);
  const after = geoMath.unproject(z, W, H, 200, 250);
  assert.ok(Math.abs(before.lon - after.lon) < 1e-6);
  assert.ok(z.k <= geoMath.MAX_ZOOM && z.k >= geoMath.MIN_ZOOM);
  console.log('[PASS] Zoom-at-cursor anchoring and zoom clamp');

  // Map must always cover the stage vertically.
  const clamped = geoMath.clampView({ lon: 0, lat: 89, k: 1 }, W, H);
  const top = geoMath.project(clamped, W, H, 0, geoMath.LAT_TOP);
  assert.ok(top.y <= 0.0001, 'map top edge should not leave a gap');
  console.log('[PASS] Vertical view clamp');

  // Arc bows upward; endpoints exact.
  const a = { x: 100, y: 300 };
  const b = { x: 500, y: 320 };
  const c = geoMath.arcControlPoint(a, b);
  assert.ok(c.y < Math.min(a.y, b.y));
  assert.deepEqual(geoMath.quadPoint(a, c, b, 0), a);
  assert.deepEqual(geoMath.quadPoint(a, c, b, 1), b);
  console.log('[PASS] Route arc geometry');

  // Card placement stays inside the stage near edges.
  for (const anchor of [{ x: 5, y: 5 }, { x: 795, y: 595 }, { x: 790, y: 10 }, { x: 400, y: 300 }]) {
    const pos = geoMath.placeCard(anchor, 190, 70, W, H);
    assert.ok(pos.left >= 12 && pos.top >= 12 && pos.left + 190 <= W - 12 && pos.top + 70 <= H - 12, JSON.stringify(pos));
  }
  console.log('[PASS] Floating card edge placement');

  // Idle tunnel shows no particles; busy tunnel is capped.
  assert.equal(geoMath.particleCount(0), 0);
  assert.equal(geoMath.particleCount(300), 0);
  assert.ok(geoMath.particleCount(120_000) >= 2);
  assert.equal(geoMath.particleCount(1e10), 6);
  console.log('[PASS] Traffic-driven particle density');

  // Colombo -> Singapore great-circle distance ≈ 2,730 km.
  const km = geoMath.haversineKm(colombo, { lon: 103.82, lat: 1.35 });
  assert.ok(km > 2600 && km < 2850, `${km}`);
  console.log('[PASS] Route distance');
}

// 6. Generated dot map is present and consistent
{
  const dots = JSON.parse(fs.readFileSync(path.resolve('public', 'assets', 'world-dots.json'), 'utf-8'));
  const cells = Buffer.from(dots.cells, 'base64');
  assert.equal(cells.length, dots.cols * dots.rows);
  const cellAt = (lon: number, lat: number) =>
    cells[Math.floor((dots.latTop - lat) / dots.step) * dots.cols + Math.floor((lon + 180) / dots.step)];
  assert.equal(dots.countries[cellAt(80.7, 7.8) - 1], 'LK', 'Sri Lanka should be land');
  assert.equal(dots.countries[cellAt(2.3, 46.5) - 1], 'FR', 'France should be land');
  assert.equal(cellAt(-30, 30), 0, 'Mid-Atlantic should be sea');
  console.log('[PASS] World dot grid geography');
}

// 7. Persistent Data Usage History & Per-Server Analytics + Data Cap Alerts
{
  const { ensureUsageHistory, recordSessionStart, recordTrafficTick } = await import('../src/main/usageTracker.ts');
  const mockData: any = {
    servers: [vlessNode, vmessNode],
    subscriptions: [],
    activeServerId: vlessNode.id,
    routingMode: 'tun',
    socksPort: 10808,
    httpPort: 10809,
    bypassLan: true,
    allowInsecureDefault: false,
    totalUp: 1000,
    totalDown: 4000,
  };

  // Migration backfills existing totalUp/totalDown
  const h = ensureUsageHistory(mockData, 1793448000000);
  assert.equal(h.perServer[vlessNode.id].downBytes, 4000);
  assert.equal(h.perServer[vlessNode.id].upBytes, 1000);

  // Configure 10 KB daily data cap with 80% warning
  h.dataCap = { enabled: true, period: 'daily', limitBytes: 10000, alertPct: 80, autoDisconnect: true };

  recordSessionStart(mockData, vlessNode, 1793448010000);
  assert.equal(h.perServer[vlessNode.id].sessions, 2);

  // Add 3500 bytes (total today = 5000 + 3500 = 8500 = 85% -> triggers 80% warning once)
  const eval1 = recordTrafficTick(mockData, vlessNode, 500, 3000, 1, 1793448020000);
  assert.equal(eval1.warnTriggered, true);
  assert.equal(eval1.limitReached, false);

  // Subsequent tick at 86% does not re-trigger warning in the same period
  const eval2 = recordTrafficTick(mockData, vlessNode, 0, 100, 1, 1793448021000);
  assert.equal(eval2.warnTriggered, false);

  // Cross 100% limit (8600 + 2000 = 10600 -> triggers limitReached)
  const eval3 = recordTrafficTick(mockData, vlessNode, 500, 1500, 1, 1793448022000);
  assert.equal(eval3.limitReached, true);
  assert.equal(h.peakDownSpeed, 3000);
  console.log('[PASS] Persistent UsageHistory buckets, per-server telemetry & Data Cap alerts');
}

// 8. QR Code Generator & Scanner (ISO/IEC 18004 + Reed-Solomon Logo Recovery + Screen Region Locator)
{
  const { applyServerEdit, toShareLink } = await import('../src/main/serverEdit.ts');
  const qrCodec = await import('../public/assets/js/qr-codec.js');
  const editedVless = applyServerEdit(vlessNode, {
    name: 'Dialog Router · Mobile Sync',
    sni: 'm.zoom.us',
    host: 'cdn.zoom.us',
  });
  const shareUri = toShareLink(editedVless);
  const qr = qrCodec.encodeQrMatrix(shareUri, 'Q');

  // Direct matrix roundtrip
  assert.equal(qrCodec.decodeQrMatrix(qr.modules), shareUri);

  // Simulate center shield logo erasure (EC-Q 25% recovers erased center codewords)
  const centerIdx = qr.size / 2;
  const logoRadiusMod = Math.min(3.1, Math.max(2.1, qr.size * 0.068));
  const withLogo = qr.modules.map((row: Uint8Array) => new Uint8Array(row));
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (Math.abs(r + 0.5 - centerIdx) <= logoRadiusMod && Math.abs(c + 0.5 - centerIdx) <= logoRadiusMod) {
        withLogo[r][c] = 0;
      }
    }
  }
  assert.equal(qrCodec.decodeQrMatrix(withLogo), shareUri);

  // Render QR code inside a larger simulated desktop screenshot (960x600) at offset (480, 120)
  const screenW = 960;
  const screenH = 600;
  const screenData = new Uint8ClampedArray(screenW * screenH * 4).fill(244);
  const scale = 5;
  const quiet = 4;
  const ox = 480;
  const oy = 120;
  const boxPx = (qr.size + quiet * 2) * scale;

  for (let y = oy; y < oy + boxPx; y++) {
    for (let x = ox; x < ox + boxPx; x++) {
      const p = (y * screenW + x) * 4;
      screenData[p] = 255;
      screenData[p + 1] = 255;
      screenData[p + 2] = 255;
      screenData[p + 3] = 255;
    }
  }
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!withLogo[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + (c + quiet) * scale + dx;
          const py = oy + (r + quiet) * scale + dy;
          const p = (py * screenW + px) * 4;
          screenData[p] = 21;
          screenData[p + 1] = 32;
          screenData[p + 2] = 40;
        }
      }
    }
  }

  const screenScan = qrCodec.decodeQrFromImageData({ width: screenW, height: screenH, data: screenData });
  assert.equal(screenScan?.text, shareUri);
  console.log('[PASS] QR Code Generator & Scanner (VLESS roundtrip, EC-Q logo recovery & desktop screenshot scan)');
}

// 9. Brave-Style Ad, Tracker & YouTube Ad Shield Engine (Xray Geosite + Log Watcher + Telemetry)
{
  const { AdBlockLogWatcher, ensureAdBlockState } = await import('../src/main/adblockEngine.ts');
  const abState = ensureAdBlockState(null);
  abState.config.customBlockedDomains.push('promo.badsite.example');
  abState.config.whitelistedDomains.push('allowed.partner.example');

  const sampleAccessLog = path.join(configDir, 'verify-access.log');
  const adblockConfig = generateXrayConfig(vlessNode, {
    tunMode: true,
    adblock: abState.config,
    accessLogPath: sampleAccessLog,
  });
  const tmpAdblockCfg = path.join(configDir, 'test-adblock-verify.json');
  if (xrayBin) {
    fs.writeFileSync(tmpAdblockCfg, JSON.stringify(adblockConfig, null, 2));
    assert.ok(validateWithXray(tmpAdblockCfg)!.includes('Configuration OK'));
    fs.unlinkSync(tmpAdblockCfg);
  }

  // Verify AdBlockLogWatcher parses Xray access log lines and categorizes YouTube ads, trackers & malware
  fs.writeFileSync(
    sampleAccessLog,
    [
      '2026/10/31 20:55:46.375432 from 127.0.0.1:57444 accepted //ads.youtube.com:443 [http-in -> adblock]',
      '2026/10/31 20:55:47.110000 from 127.0.0.1:57445 accepted tcp:googleads.g.doubleclick.net:443 [socks-in -> adblock]',
      '2026/10/31 20:55:48.220000 from 127.0.0.1:57446 accepted //scorecardresearch.com:443 [http-in -> adblock]',
      '2026/10/31 20:55:49.330000 from 127.0.0.1:57447 accepted //coinhive.com:443 [http-in -> adblock]',
      '2026/10/31 20:55:50.440000 from 127.0.0.1:57448 accepted //promo.badsite.example:443 [http-in -> adblock]',
    ].join('\n'),
    'utf-8'
  );
  const watcher = new AdBlockLogWatcher();
  const count = watcher.poll(sampleAccessLog, abState);
  fs.unlinkSync(sampleAccessLog);

  assert.equal(count, 5);
  assert.equal(abState.totalBlocked, 5);
  assert.equal(abState.byCategory.youtube_ads.blocked, 2);
  assert.equal(abState.byCategory.trackers.blocked, 1);
  assert.equal(abState.byCategory.malware.blocked, 1);
  assert.equal(abState.byCategory.custom.blocked, 1);
  assert.ok(abState.savedBytes > 150000);
  console.log(`[PASS] Brave-Style Ad, Tracker & YouTube Ad Shield Engine${xrayBin ? ' validated with Xray' : ''}`);
}

// 10. Smart Split Tunneling Engine (Bypass VPN vs VPN-Only Routing + Route Simulator + Xray validation)
{
  const {
    ensureSplitTunnelConfig,
    evaluateSplitTunnelRoute,
    parseSplitTargetInput,
  } = await import('../src/main/splitTunnelEngine.ts');

  assert.deepEqual(parseSplitTargetInput('*.combank.lk/login'), { kind: 'domain', value: 'combank.lk' });
  assert.deepEqual(parseSplitTargetInput('.lk'), { kind: 'domain', value: 'lk' });
  assert.deepEqual(parseSplitTargetInput('203.115.0.0/16'), { kind: 'ip', value: '203.115.0.0/16' });

  // Bypass Mode: Sri Lanka + Gaming bypass VPN (direct), everything else uses VPN (proxy)
  const bypassCfg = ensureSplitTunnelConfig({
    mode: 'bypass',
    presets: {
      sri_lanka_local: true,
      gaming: true,
      streaming: false,
      messaging: false,
      ai_cloud: false,
      windows_updates: false,
    },
    customDomains: ['mybank.example'],
    customIps: ['203.115.0.0/16'],
  });

  const v1 = evaluateSplitTunnelRoute('online.combank.lk', bypassCfg, null, true);
  assert.equal(v1.outbound, 'direct');
  const v2 = evaluateSplitTunnelRoute('store.steampowered.com', bypassCfg, null, true);
  assert.equal(v2.outbound, 'direct');
  const v3 = evaluateSplitTunnelRoute('203.115.42.10', bypassCfg, null, true);
  assert.equal(v3.outbound, 'direct');
  const v4 = evaluateSplitTunnelRoute('chatgpt.com', bypassCfg, null, true);
  assert.equal(v4.outbound, 'proxy');

  // VPN-Only Mode: Only AI Cloud uses VPN (proxy), everything else uses Direct ISP (direct)
  const vpnOnlyCfg = ensureSplitTunnelConfig({
    mode: 'vpn_only',
    presets: {
      sri_lanka_local: false,
      gaming: false,
      streaming: false,
      messaging: false,
      ai_cloud: true,
      windows_updates: false,
    },
    customDomains: ['blocked-region.example'],
    customIps: [],
  });

  const v5 = evaluateSplitTunnelRoute('chatgpt.com', vpnOnlyCfg, null, true);
  assert.equal(v5.outbound, 'proxy');
  const v6 = evaluateSplitTunnelRoute('combank.lk', vpnOnlyCfg, null, true);
  assert.equal(v6.outbound, 'direct');

  if (xrayBin) {
    for (const stModeCfg of [bypassCfg, vpnOnlyCfg]) {
      const xrayCfg = generateXrayConfig(vlessNode, {
        tunMode: true,
        splitTunnel: stModeCfg,
      });
      const tmpSplitCfg = path.join(configDir, 'test-split-verify.json');
      fs.writeFileSync(tmpSplitCfg, JSON.stringify(xrayCfg, null, 2));
      const out = validateWithXray(tmpSplitCfg)!;
      assert.ok(out.includes('Configuration OK'));
      fs.unlinkSync(tmpSplitCfg);
    }
  }
  console.log(`[PASS] Smart Split Tunneling Engine (Bypass & VPN-Only modes)${xrayBin ? ' validated with Xray' : ''}`);
}

console.log('--- All Verification Checks Passed! ---');
