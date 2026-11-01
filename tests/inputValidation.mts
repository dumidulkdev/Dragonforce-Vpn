import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMultipleLinks, parseShareLink } from '../src/main/parser.ts';
import { applyServerEdit, toShareLink } from '../src/main/serverEdit.ts';
import { generateXrayConfig } from '../src/main/xrayConfig.ts';
import { ensureSplitTunnelConfig, evaluateSplitTunnelRoute, parseSplitTargetInput } from '../src/main/splitTunnelEngine.ts';
import { backend } from './helpers/backend.mts';

const base = 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@vpn.example:443?security=tls&type=ws';

await test('VLESS share/edit round-trips preserve nested percent escapes and literal percent signs', () => {
  for (const path of ['/ws?token=a%2Fb', '/ws?token=100%', '/ws?token=a%252Fb+value', '/ws%2Fsegment?token=a%2Fb']) {
    const uri = `${base}&path=${encodeURIComponent(path)}&spx=${encodeURIComponent(path)}&alpn=${encodeURIComponent('h2%test,http/1.1')}`;
    const node = parseShareLink(uri);
    assert.equal(node.path, path);
    assert.equal(node.spiderX, path);
    assert.deepEqual(node.alpn, ['h2%test', 'http/1.1']);
    const edited = applyServerEdit(node, { path });
    assert.equal(parseShareLink(toShareLink(edited)).path, path);
    assert.equal(((generateXrayConfig(node).outbounds as any[])[0]).streamSettings.wsSettings.path, path);
  }
});

await test('NetMod and legacy panel paths decode slash escapes while preserving the full path text', () => {
  for (const [encoded, expected] of [
    ['%2f', '/'], ['%2Fws%2Fchat', '/ws/chat'],
    ['%252f', '/'], ['%252Fws%252fchat', '/ws/chat'],
    ['%252fws%253Ftoken%253Da%25252Fb', '/ws?token=a%2Fb'],
  ]) {
    const node = parseShareLink(`${base}&flow=none&path=${encoded}`);
    assert.equal(node.path, expected);
    assert.equal(node.flow, undefined);
    assert.equal(node.allowInsecure, false);
    assert.equal(parseShareLink(toShareLink(node)).path, expected);
    assert.equal((generateXrayConfig(node).outbounds as any[])[0].streamSettings.wsSettings.path, expected);
  }

  // Previously imported profiles must work without requiring deletion/reimport.
  const saved = { ...parseShareLink(base), path: '%2fws%2Fchat' };
  assert.equal((generateXrayConfig(saved).outbounds as any[])[0].streamSettings.wsSettings.path, '/ws/chat');
  assert.equal(applyServerEdit(saved, { name: 'Legacy WebSocket' }).path, '/ws/chat');
  assert.equal(new URL(toShareLink(saved)).searchParams.get('path'), '/ws/chat');

  const grpc = parseShareLink(`${base.replace('type=ws', 'type=grpc')}&serviceName=%252fservice`);
  assert.equal(grpc.path, '%2fservice', 'gRPC service names are not HTTP paths');
  assert.equal(parseShareLink(`${base}&path=%252fws%25broken`).path, '%2fws%broken');
});

await test('legacy insecure flags and encoded paths survive VLESS/VMess import and export', () => {
  const vmess = (values: Record<string, unknown>) => 'vmess://' + Buffer.from(JSON.stringify({
    add: 'vpn.example', port: 443, id: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    net: 'ws', tls: 'tls', path: '%2fws%2Fchat', ...values,
  })).toString('base64');
  for (const key of ['allowInsecure', 'insecure', 'allow_insecure']) {
    for (const value of [true, 1, 'true', 'TRUE', '1', false, 0, 'false', '0', 'untrue']) {
      const expected = [true, 1, 'true', 'TRUE', '1'].includes(value);
      for (const uri of [
        `${base}&path=%252fws%252fchat&${key}=${value}`,
        `${base.replace('vless://', 'vmess://')}&path=%252fws%252fchat&${key}=${value}`,
        vmess({ [key]: value }),
      ]) {
        const node = parseShareLink(uri);
        assert.equal(node.allowInsecure, expected, `${key}=${value}`);
        assert.equal(node.path, '/ws/chat');
        const restored = parseShareLink(toShareLink(applyServerEdit(node, { name: 'Legacy server' })));
        assert.equal(restored.allowInsecure, expected);
        assert.equal(restored.path, '/ws/chat');
      }
    }
  }
});

await test('VMess JSON rejects invalid ports instead of silently accepting or defaulting them', () => {
  const vmess = (port: unknown) => 'vmess://' + Buffer.from(JSON.stringify({ add: 'vpn.example', id: 'b831381d-6324-4d53-ad4f-8cda48b30811', port })).toString('base64');
  for (const port of [99999, 65536, 0, -1, 443.5, 'NaN', 'Infinity', '1e3', '', null, true, []]) {
    assert.throws(() => parseShareLink(vmess(port)), /Port/, JSON.stringify(port));
    const result = parseMultipleLinks(vmess(port));
    assert.equal(result.nodes.length, 0);
    assert.equal(result.errors.length, 1);
  }
  for (const port of [1, 65535, '443']) assert.equal(parseShareLink(vmess(port)).port, Number(port));
});

await test('server editing and saved config generation reject malformed IP addresses and ports', () => {
  const node = parseShareLink(base);
  for (const address of ['abcd:::', '2001:db8::1::2', '999.2.3.4', '192.168.01.1', 'bad..host', 'host:443']) {
    assert.throws(() => applyServerEdit(node, { address }), /address/, address);
    assert.throws(() => generateXrayConfig({ ...node, address }), /address/, address);
  }
  assert.equal(applyServerEdit(node, { address: '[2001:db8::1]' }).address, '2001:db8::1');
  assert.throws(() => generateXrayConfig({ ...node, port: 99999 }), /Port/);
});

await test('split rules validate complete IPv4/IPv6 literals and prefix lengths', () => {
  for (const target of ['abcd:::/999', '2001:db8::/129', '::/999', 'abcd:', '2001::db8::1', '::/1/2', '::/-1', '::/1.5', '1.2.3.4/33', '999.1.1.1/24', 'bad..example']) {
    assert.equal(parseSplitTargetInput(target), null, target);
  }
  for (const target of ['2001:db8::/32', '::/0', '::1/128', '192.0.2.0/24', '192.0.2.1', '::ffff:192.0.2.1']) {
    assert.deepEqual(parseSplitTargetInput(target), { kind: 'ip', value: target });
  }
  const split = ensureSplitTunnelConfig({ mode: 'bypass', customIps: ['2001:db8::/32', '192.0.2.0/24'] });
  assert.equal(evaluateSplitTunnelRoute('2001:db8:1234::5', split).outbound, 'direct');
  assert.equal(evaluateSplitTunnelRoute('2001:db9::1', split).outbound, 'proxy');
  assert.equal(evaluateSplitTunnelRoute('192.0.2.50', split).outbound, 'direct');
  assert.equal(evaluateSplitTunnelRoute('192.0.3.1', split).outbound, 'proxy');
  assert.equal(evaluateSplitTunnelRoute('fc00::1', null, null, true).outbound, 'direct');
  assert.equal(evaluateSplitTunnelRoute('fc00::1', null, null, false).outbound, 'proxy');
});

await test('invalid split targets are rejected by the API without changing a live connection', async () => {
  const b = await backend();
  await b.call('connect');
  const before = JSON.stringify((await b.state()).data.splitTunnel);
  const result = await b.api('/api/split-tunnel/config', { addTarget: 'abcd:::/999' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify((await b.state()).data.splitTunnel), before);
  assert.equal(b.controls.starts, 1);
  assert.equal((await b.state()).status.connected, true);
  await b.call('disconnect');
});
