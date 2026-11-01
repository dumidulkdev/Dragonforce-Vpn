import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import net from 'node:net';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { clearServerPing, measureServerPings, pingServerTcp } from '../src/main/serverPing.ts';
import { parseShareLink } from '../src/main/parser.ts';

let connections = 0;
const server = net.createServer(() => { connections++; });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as net.AddressInfo).port;
const makeNode = (host = '127.0.0.1') => parseShareLink(
  `vless://b831381d-6324-4d53-ad4f-8cda48b30811@${host}:${port}?type=tcp`
);

try {
  const result = await pingServerTcp('127.0.0.1', port);
  assert.equal(result.pingStatus, 'ok');
  assert.ok(result.ping >= 1);
  assert.ok(result.pingCheckedAt > 0);
  console.log('[PASS] TCP latency measures a real listening endpoint');

  // A slow DNS lookup must not inflate the reported handshake time.
  const lookup = mock.method(dns, 'lookup', async () => {
    await delay(180);
    return [{ address: '127.0.0.1', family: 4 }];
  });
  try {
    const started = performance.now();
    const delayed = await pingServerTcp('slow-dns.example', port);
    assert.equal(delayed.pingStatus, 'ok');
    assert.ok(performance.now() - started >= 160);
    assert.ok(delayed.ping < 150, 'DNS delay must be excluded from the RTT');
  } finally {
    lookup.mock.restore();
  }
  console.log('[PASS] TCP latency excludes DNS resolution time');

  // DNS failures and DNS deadlines are distinct from a TCP connection timeout.
  const missingLookup = mock.method(dns, 'lookup', async () => {
    throw Object.assign(new Error('Host not found'), { code: 'ENOTFOUND' });
  });
  try {
    assert.equal((await pingServerTcp('missing.example', port)).pingStatus, 'dns-error');
  } finally {
    missingLookup.mock.restore();
  }
  const stalledLookup = mock.method(dns, 'lookup', () => new Promise(() => {}));
  try {
    const started = performance.now();
    const stalled = await pingServerTcp('stalled-dns.example', port, { timeoutMs: 60 });
    assert.equal(stalled.pingStatus, 'dns-error');
    assert.match(stalled.pingError!, /timed out/);
    assert.ok(performance.now() - started < 1000, 'DNS must obey the overall deadline');
  } finally {
    stalledLookup.mock.restore();
  }
  console.log('[PASS] DNS failures and stalled DNS are reported accurately');

  const stalledConnect = mock.method(net.Socket.prototype, 'connect', function (this: net.Socket) {
    return this;
  });
  try {
    const stalled = await pingServerTcp('127.0.0.1', port, { timeoutMs: 60 });
    assert.equal(stalled.pingStatus, 'timeout');
    assert.equal(stalled.ping, -1);
  } finally {
    stalledConnect.mock.restore();
  }
  console.log('[PASS] A stalled TCP connection obeys the probe deadline');

  // Profiles sharing an endpoint get one measurement, and expose progress immediately.
  const nodes = [makeNode(), makeNode()];
  const before = connections;
  const statuses: string[][] = [];
  await measureServerPings(nodes, () => statuses.push(nodes.map((n) => n.pingStatus!)), {});
  assert.deepEqual(statuses[0], ['measuring', 'measuring']);
  assert.deepEqual(statuses.at(-1), ['ok', 'ok']);
  assert.equal(nodes[0].ping, nodes[1].ping);
  assert.equal(nodes[0].pingCheckedAt, nodes[1].pingCheckedAt);
  assert.equal(connections - before, 3, 'duplicate endpoints must share the same three handshakes');
  console.log('[PASS] Ping batches publish progress and deduplicate endpoints');

  // An earlier, slow failure must never overwrite a newer successful retry.
  let rejectOld!: (error: Error) => void;
  const oldDns = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
  let lookups = 0;
  const racingLookup = mock.method(dns, 'lookup', async () => {
    if (++lookups === 1) return oldDns;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  try {
    const node = makeNode('retry.example');
    const oldRun = measureServerPings([node], () => {}, {});
    await measureServerPings([node], () => {}, {});
    assert.equal(node.pingStatus, 'ok');
    const latest = node.pingCheckedAt;
    rejectOld(new Error('Old DNS failure'));
    await oldRun;
    assert.equal(node.pingStatus, 'ok');
    assert.equal(node.pingCheckedAt, latest);
    clearServerPing(node);
    assert.equal(node.ping, null);
    assert.equal(node.pingStatus, undefined);
    assert.equal(node.pingCheckedAt, undefined);
  } finally {
    racingLookup.mock.restore();
  }
  console.log('[PASS] Late ping failures cannot overwrite a successful retry');
} finally {
  mock.restoreAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Reuse the now-closed local port to verify a refused connection is not called a timeout.
const refused = await pingServerTcp('127.0.0.1', port);
assert.equal(refused.pingStatus, 'refused');
assert.equal(refused.ping, -1);
console.log('[PASS] Closed TCP ports are reported as refused');
