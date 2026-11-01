import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { parseShareLink } from '../src/main/parser.ts';
import { generateXrayConfig } from '../src/main/xrayConfig.ts';
import { defaultAdBlockConfig } from '../src/main/adblockEngine.ts';
import { ensureSplitTunnelConfig, evaluateSplitTunnelRoute } from '../src/main/splitTunnelEngine.ts';
import { verifyAdBlock } from '../src/main/adblockVerification.ts';
import { resolveNativeBinaries } from '../src/main/binaries.ts';

const nativeBinaries = resolveNativeBinaries({
  bundledBinDir: path.resolve(process.env.VPN_BIN_DIR || 'resources/bin'),
});
const xray = nativeBinaries.xrayPath;
const node = parseShareLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@test.invalid:443?security=tls');

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function readRoute(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${net.isIPv6(host) ? `[${host}]` : host}:443`, agent: false });
    let tunnel: net.Socket | undefined;
    const timer = setTimeout(() => finish(new Error(`No response for ${host}`)), 2500);
    function finish(error?: Error, value?: string) {
      clearTimeout(timer);
      tunnel?.destroy();
      req.destroy();
      if (error) reject(error);
      else resolve(value!);
    }
    req.once('error', finish);
    req.once('connect', (_res, socket, head) => {
      tunnel = socket;
      socket.once('error', finish);
      if (head.length) finish(undefined, head.toString());
      else socket.once('data', (data) => finish(undefined, data.toString()));
    });
    req.end();
  });
}

for (const mode of ['off', 'bypass', 'vpn_only'] as const) {
  await test(`native Xray: Shield whitelist preserves ${mode} routes, including nested suffixes`, { skip: !xray }, async () => {
    assert.ok(xray);
    const root = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA!, 'Temp', 'opencode') : os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    const temp = fs.mkdtempSync(path.join(root, 'vpn-routing-'));
    const log = path.join(temp, 'access.log');
    const direct = net.createServer(socket => socket.end('direct'));
    const proxy = net.createServer(socket => socket.end('proxy'));
    const reservations = Array.from({ length: 3 }, () => net.createServer());
    const [directPort, proxyPort, socksPort, httpPort, apiPort] = await Promise.all([direct, proxy, ...reservations].map(listen));
    await Promise.all(reservations.map(server => new Promise<void>(resolve => server.close(() => resolve()))));

    const shield = {
      ...defaultAdBlockConfig(), adguardDns: false,
      whitelistedDomains: ['combank.lk', 'ads.youtube.com', 'parent.test', 'allowed.broad.test'],
      customBlockedDomains: ['parent.test', 'broad.test'],
    };
    const split = ensureSplitTunnelConfig({
      mode,
      presets: { sri_lanka_local: false, gaming: false, streaming: false, messaging: false, ai_cloud: false, windows_updates: false },
      customDomains: ['combank.lk', 'ads.youtube.com', 'exception.parent.test', 'broad.test'],
      customIps: ['2001:db8::/32', '192.0.2.0/24'],
    });
    const config = generateXrayConfig(node, { socksPort, httpPort, apiPort, bypassLan: false, adblock: shield, splitTunnel: split, accessLogPath: log });
    // Keep the generated routing rules, but terminate both network routes locally.
    // Distinct replies prove which outbound Xray actually selected without internet traffic.
    config.outbounds = (config.outbounds as any[]).map(outbound => outbound.tag === 'direct' || outbound.tag === 'proxy'
      ? { tag: outbound.tag, protocol: 'freedom', settings: { redirect: `127.0.0.1:${outbound.tag === 'direct' ? directPort : proxyPort}` } }
      : outbound);
    const file = path.join(temp, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const assetEnv = nativeBinaries.xrayAssetDir
      ? { ...process.env, XRAY_LOCATION_ASSET: nativeBinaries.xrayAssetDir }
      : undefined;
    const proc = spawn(xray, ['run', '-c', file], { cwd: path.dirname(xray), env: assetEnv, windowsHide: true });
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { output += chunk; });
    const exit = once(proc, 'exit');
    try {
      const deadline = Date.now() + 5000;
      while (true) {
        const ready = await new Promise<boolean>(resolve => {
          const socket = net.connect(httpPort, '127.0.0.1');
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => resolve(false));
        });
        if (ready) break;
        assert.equal(proc.exitCode, null, output);
        assert.ok(Date.now() < deadline, output);
        await delay(25);
      }
      const selected = mode === 'bypass' ? 'direct' : 'proxy';
      const fallback = mode === 'vpn_only' ? 'direct' : 'proxy';
      for (const [host, expected] of [
        ['combank.lk', selected], ['ads.youtube.com', selected],
        ['exception.parent.test', selected], ['other.parent.test', fallback],
        ['allowed.broad.test', selected], ['innocent.test', fallback],
        ['2001:db8:1234::5', selected], ['2001:db9::1', fallback],
        ['192.0.2.5', selected],
      ]) {
        assert.equal(await readRoute(httpPort, host), expected, host);
        assert.equal(evaluateSplitTunnelRoute(host, split, shield).outbound, expected, host);
      }
      const blocked = await verifyAdBlock(httpPort, log, ['other.broad.test', 'scorecardresearch.com'], 1500);
      assert.equal(blocked.ok, true, JSON.stringify(blocked));
      const explanation = evaluateSplitTunnelRoute('scorecardresearch.com', split, shield);
      assert.equal(explanation.outbound, 'adblock');
      assert.ok(explanation.matchedRule);
      assert.doesNotMatch(explanation.matchedSource, /undefined/);
    } finally {
      if (proc.exitCode === null) proc.kill();
      await exit;
      await Promise.all([direct, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      fs.rmSync(temp, { recursive: true });
    }
  });
}
