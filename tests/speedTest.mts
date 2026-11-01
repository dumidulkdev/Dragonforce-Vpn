import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { mock, test } from 'node:test';
import { SpeedTest } from '../src/main/speedTest.ts';

await test('speed requests send GET and POST over the supplied socket without direct HTTPS connections', async () => {
  const seen: Array<{ method: string; body: string; host: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method!, body: Buffer.concat(chunks).toString(), host: req.headers.host! });
    res.end('via supplied socket');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  await once(socket, 'connect');
  const guard = mock.method(https.Agent.prototype, 'createConnection', () => { throw new Error('Unexpected direct connection'); });
  const speed = new SpeedTest(10809, () => {});
  try {
    for (const method of ['GET', 'POST']) {
      const response = await new Promise<string>((resolve, reject) => {
        const req = (speed as any).request(socket, method, '/probe', { 'Content-Length': method === 'POST' ? 7 : 0 });
        req.once('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Request timed out')));
        req.once('response', async (res: http.IncomingMessage) => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve(Buffer.concat(chunks).toString());
        });
        req.end(method === 'POST' ? 'payload' : undefined);
      });
      assert.equal(response, 'via supplied socket');
    }
    assert.deepEqual(seen, [
      { method: 'GET', body: '', host: 'speed.cloudflare.com' },
      { method: 'POST', body: 'payload', host: 'speed.cloudflare.com' },
    ]);
    assert.equal(guard.mock.callCount(), 0);
  } finally {
    speed.abort();
    socket.destroy();
    guard.mock.restore();
    server.close();
    await once(server, 'close');
  }
});

await test('cancelling a pending proxy handshake closes it and rejects the operation', async () => {
  const server = http.createServer();
  let raw: net.Socket | undefined;
  const connected = new Promise<void>(resolve => server.once('connect', (_req, socket) => { raw = socket; resolve(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const speed = new SpeedTest((server.address() as net.AddressInfo).port, () => {});
  try {
    const pending = (speed as any).openTls();
    const rejected = assert.rejects(pending, /cancelled/);
    await connected;
    speed.abort();
    await rejected;
  } finally {
    raw?.destroy();
    server.close();
    await once(server, 'close');
  }
});
