import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { verifyAdBlock } from '../src/main/adblockVerification.ts';

async function withProbeServer(run: (port: number, log: string, server: http.Server) => Promise<void>) {
  const root = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA!, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, 'vpn-shield-'));
  const log = path.join(temp, 'access.log');
  fs.writeFileSync(log, '');
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run((server.address() as any).port, log, server);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    fs.rmSync(temp, { recursive: true });
  }
}

await test('Shield verification requires fresh log entries for each probe source port and target', async () => {
  await withProbeServer(async (port, log, server) => {
    server.on('connect', (req, socket) => {
      fs.appendFileSync(log, `2026/11/01 10:00:00 from 127.0.0.1:${socket.remotePort} accepted //${req.url} [http-in -> adblock]\n`);
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    const targets = ['ads.youtube.com', 'coinhive.com'];
    const result = await verifyAdBlock(port, log, targets, 500);
    assert.equal(result.ok, true);
    assert.equal(result.blockedCount, 2);
    assert.deepEqual(new Set(result.verifiedTargets), new Set(targets));
    assert.deepEqual(result.unverifiedTargets, []);
  });
});

await test('successful CONNECTs, stale entries, other probes and direct routes cannot pass verification', async () => {
  await withProbeServer(async (port, log, server) => {
    fs.writeFileSync(log, '2026/11/01 09:00:00 from 127.0.0.1:12345 accepted //ads.youtube.com:443 [http-in -> adblock]\n');
    server.on('connect', (req, socket) => {
      fs.appendFileSync(log, [
        `from 127.0.0.1:${socket.remotePort} accepted //${req.url} [http-in -> proxy]`,
        `from 127.0.0.1:${socket.remotePort} accepted //unrelated.test:443 [http-in -> adblock]`,
        `from 127.0.0.1:${socket.remotePort! - 1} accepted //${req.url} [http-in -> adblock]`,
      ].join('\n') + '\n');
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    const result = await verifyAdBlock(port, log, ['ads.youtube.com'], 150);
    assert.equal(result.ok, false);
    assert.equal(result.blockedCount, 0);
    assert.deepEqual(result.unverifiedTargets, ['ads.youtube.com']);
  });
});
