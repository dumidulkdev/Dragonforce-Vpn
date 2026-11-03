import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  decodeBase64Utf8,
  encodeBase64Utf8,
  ensureAdBlockState,
  ensureSplitTunnelConfig,
  evaluateSplitTunnelRoute,
  generateXrayConfig,
  hostnameToAscii,
  ipFamily,
  ipInCidr,
  parseAdBlockAccessLogChunk,
  parseIpv4,
  parseIpv6,
  parseShareLink,
  randomId,
} from '../packages/core/src/index.ts';

test('packages/core contains zero node:* imports so it runs in Android WebView & browsers', () => {
  const coreDir = path.resolve('packages/core/src');
  const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 10, 'Expected core source files to exist');

  for (const file of files) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.equal(
      /from\s+['"]node:/.test(content),
      false,
      `packages/core/src/${file} must not import node:* modules`
    );
  }
});

test('netUtils parses IPv4, IPv6, CIDR ranges, Base64 UTF-8, and Punycode hostnames', () => {
  assert.deepEqual(parseIpv4('192.168.1.1'), [192, 168, 1, 1]);
  assert.equal(parseIpv4('256.0.0.1'), null);
  assert.equal(parseIpv4('01.2.3.4'), null);

  assert.equal(ipFamily('10.0.0.1'), 4);
  assert.equal(ipFamily('2001:db8::1'), 6);
  assert.equal(ipFamily('::ffff:192.0.2.128'), 6);
  assert.equal(ipFamily('example.com'), 0);

  assert.ok(parseIpv6('2001:db8::1'));
  assert.equal(parseIpv6('2001::db8::1'), null);

  assert.equal(ipInCidr('192.168.1.42', '192.168.1.0', 24), true);
  assert.equal(ipInCidr('192.168.2.42', '192.168.1.0', 24), false);
  assert.equal(ipInCidr('2001:db8::abcd', '2001:db8::', 32), true);
  assert.equal(ipInCidr('2001:db9::abcd', '2001:db8::', 32), false);

  const sample = 'DragonForce 🐉 VPN — श्रीलंका / ලංකා';
  const b64 = encodeBase64Utf8(sample);
  assert.equal(decodeBase64Utf8(b64), sample);

  assert.equal(hostnameToAscii('bücher.example'), 'xn--bcher-kva.example');
  assert.match(randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('splitTunnelEngine sanitizes Android per-app split tunneling configuration', () => {
  const cfg = ensureSplitTunnelConfig({
    mode: 'bypass',
    perAppMode: 'bypass_selected',
    selectedApps: [
      'com.whatsapp',
      'lk.combank.digital',
      'com.whatsapp', // duplicate
      'invalid package!',
      'singleword',
      'org.telegram.messenger',
    ],
  });

  assert.equal(cfg.perAppMode, 'bypass_selected');
  assert.deepEqual(cfg.selectedApps, [
    'com.whatsapp',
    'lk.combank.digital',
    'org.telegram.messenger',
  ]);

  const route = evaluateSplitTunnelRoute('combank.lk', cfg, null, true);
  assert.equal(route.outbound, 'direct');
});

test('parseAdBlockAccessLogChunk records blocked domains from Android/desktop log streams', () => {
  const state = ensureAdBlockState(null);
  const chunk = [
    '2026/11/04 10:12:01 from 127.0.0.1:51234 accepted tcp:googleads.g.doubleclick.net:443 [socks-in -> adblock]',
    '2026/11/04 10:12:02 from 127.0.0.1:51235 accepted //ads.youtube.com:443 [http-in -> adblock]',
    '2026/11/04 10:12:03 from 127.0.0.1:51236 accepted tcp:cloudflare.com:443 [socks-in -> proxy]',
  ].join('\n');

  const count = parseAdBlockAccessLogChunk(chunk, state);
  assert.equal(count, 2);
  assert.equal(state.totalBlocked, 2);
  assert.equal(state.byCategory.youtube_ads.blocked, 2);
});

test('packages/core parses share links and generates Xray config identically', () => {
  const node = parseShareLink(
    'vless://b831381d-6324-4d53-ad4f-8cda48b30811@sg.dragonforce.example:443?security=tls&type=ws&path=%2Fws&sni=sg.dragonforce.example#Singapore-01'
  );
  const cfg = generateXrayConfig(node, { tunMode: true });
  assert.equal(node.name, 'Singapore-01');
  assert.ok(Array.isArray(cfg.inbounds));
  assert.ok(Array.isArray(cfg.outbounds));
});
