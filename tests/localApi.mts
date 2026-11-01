import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { mock, test } from 'node:test';
import { backend } from './helpers/backend.mts';
import { serveAsset } from '../src/main/httpAssets.ts';
import { stopPreviousController } from '../src/main/controllerInstance.ts';

await test('local API rejects foreign origins, rebound hosts, simple POSTs and missing tokens before mutation', async () => {
  const b = await backend();
  for (const headers of [
    { origin: 'https://foreign.example' },
    { host: 'rebound.example:17890' },
    { 'sec-fetch-site': 'cross-site' },
    { 'content-type': 'text/plain' },
    { 'x-dragonforce-token': '' },
    { 'x-dragonforce-token': 'f'.repeat(64) },
  ]) {
    const result = await b.api('/api/settings', { theme: 'dark' }, headers);
    assert.ok(result.httpStatus === 403 || result.httpStatus === 415, JSON.stringify(result));
    assert.equal((await b.state()).data.theme, 'light');
  }
  assert.equal((await b.api('/api/settings', { theme: 'dark' })).ok, true);
  assert.equal((await b.state()).data.theme, 'dark');
});

await test('asset directories, traversal and asynchronous read errors do not crash the server', async () => {
  const tempRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA!, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'vpn-assets-'));
  const assets = path.join(temp, 'assets');
  fs.mkdirSync(path.join(assets, 'js'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'js', 'app.js'), 'export const ok = true;');
  fs.writeFileSync(path.join(temp, 'secret.txt'), 'private');
  const server = http.createServer((req, res) => {
    if (!serveAsset(assets, req.url!, res, { '.js': 'text/javascript' })) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const route of ['/assets/js/', '/assets/%', '/assets/..%5csecret.txt', '/assets/missing.js']) {
      assert.equal((await fetch(base + route)).status, 404);
    }
    const response = await fetch(base + '/assets/js/app.js');
    assert.equal(await response.text(), 'export const ok = true;');
    const broken = mock.method(fs, 'createReadStream', () => {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(Object.assign(new Error('Read failed'), { code: 'EACCES' })));
      return stream as any;
    });
    try { assert.equal((await fetch(base + '/assets/js/app.js')).status, 500); }
    finally { broken.mock.restore(); }
    assert.equal((await fetch(base + '/assets/js/app.js')).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    fs.rmSync(temp, { recursive: true });
  }
});

await test('controller takeover authenticates shutdown and waits for graceful port release', async () => {
  let shutdowns = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/init') { res.end(JSON.stringify({ appId: 'dragonforce-vpn', apiToken: 'test-session' })); return; }
    assert.equal(req.headers['x-dragonforce-token'], 'test-session');
    assert.equal(req.headers['content-type'], 'application/json');
    shutdowns++;
    res.once('finish', () => { server.closeAllConnections(); server.close(); });
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await stopPreviousController((server.address() as any).port);
  assert.equal(shutdowns, 1);
  assert.equal(server.listening, false);
});

await test('controller takeover leaves an unrelated service alone', async () => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.end('{"appId":"another-app"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(stopPreviousController((server.address() as any).port), /another application/);
    assert.equal(posts, 0);
    assert.equal(server.listening, true);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});
