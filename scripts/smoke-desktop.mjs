import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const executable = path.resolve(process.argv[2] || 'release/win-unpacked/DragonForce-VPN.exe');
const temporaryRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : os.tmpdir();
await fs.mkdir(temporaryRoot, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(temporaryRoot, 'vpn-release-smoke-'));
const reservations = Array.from({ length: 2 }, () => net.createServer());
const [port, debugPort] = await Promise.all(reservations.map(async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}));
await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
const env = { ...process.env, VPN_DATA_DIR: dataDir, VPN_UI_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const exited = once(child, 'exit');
let websocket;
const base = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 90000;
  let page;
  while (!page) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, `Dashboard did not start. Data: ${dataDir}\n${output}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      page = pages.find(item => item.type === 'page' && item.url.startsWith(base));
    } catch { /* Electron or the portable extractor is still starting. */ }
    if (!page) await delay(100);
  }
  websocket = new WebSocket(page.webSocketDebuggerUrl);
  await once(websocket, 'open');
  let sequence = 0;
  const requests = new Map();
  const exceptions = [];
  websocket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if (message.id) {
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  const navigationDeadline = Date.now() + 15000;
  while (true) {
    try {
      const ready = await call('Runtime.evaluate', {
        expression: `location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`, returnByValue: true,
      });
      if (ready.result?.value === true) break;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
    }
    assert.ok(Date.now() < navigationDeadline, 'The dashboard navigation did not complete');
    await delay(50);
  }
  const result = await call('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      const deadline = Date.now() + 15000;
      while (!document.querySelector('.ob-modal')) {
        if (Date.now() > deadline) throw new Error('Fresh-install onboarding did not render');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const initial = await (await fetch('/api/init')).json();
      document.querySelector('.ob-modal [data-act="skip"]').click();
      while (document.querySelector('.ob-modal')) {
        if (Date.now() > deadline) throw new Error('Onboarding could not finish');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const views = [];
      for (const id of ['dashboard', 'shield', 'split', 'usage', 'speed', 'servers', 'subscriptions', 'logs', 'settings']) {
        document.querySelector('[data-nav="' + id + '"]').click();
        const view = document.querySelector('#view-' + id);
        if (view.hidden || view.textContent.trim().length < 5) throw new Error('View did not render: ' + id);
        views.push(id);
      }
      document.querySelector('[data-nav="servers"]').click();
       document.querySelector('#view-servers [data-act="scan-qr"]').click();
       if (!document.querySelector('#modal-root').textContent.includes('QR')) throw new Error('QR tools did not open');
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
       document.querySelector('[data-ref="linkInput"]').value = 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@legacy.example:443/?security=tls&type=ws&flow=none&path=%252fws%252fchat&allowInsecure=true#Legacy%20import';
       document.querySelector('#view-servers [data-act="import"]').click();
       while (!document.querySelector('#view-servers [data-act="edit-server"]')) {
         if (Date.now() > deadline) throw new Error('Legacy profile did not import');
         await new Promise(resolve => setTimeout(resolve, 50));
       }
       document.querySelector('#view-servers [data-act="edit-server"]').click();
       const editor = document.querySelector('#modal-root form');
       if (editor.elements.path.value !== '/ws/chat') throw new Error('Encoded path text was not normalized');
       if (editor.querySelector('[name="allowInsecure"]').getAttribute('aria-checked') !== 'true') throw new Error('Legacy insecure flag was not imported');
       editor.requestSubmit();
       while (document.querySelector('#modal-root form')) {
         if (Date.now() > deadline) throw new Error('Legacy profile could not be saved');
         await new Promise(resolve => setTimeout(resolve, 50));
       }
       const updated = await (await fetch('/api/init')).json();
       const legacy = updated.data.servers[0];
       const shared = new URL(legacy.rawUri);
       const asset = await fetch('/assets/css/app.css');
       return { title: document.title, connected: initial.status.connected, servers: initial.data.servers.length,
         binaries: initial.status.binariesReady, views, stylesheet: asset.status,
         legacyImport: { path: legacy.path, allowInsecure: legacy.allowInsecure, sharedPath: shared.searchParams.get('path'), sharedInsecure: shared.searchParams.get('allowInsecure') },
         nodeInRenderer: typeof process !== 'undefined' || typeof require !== 'undefined' };
    })()`,
  });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  const state = result.result.value;
  assert.equal(state.connected, false);
  assert.equal(state.servers, 0);
  assert.deepEqual(state.binaries, { xray: true, tun2socks: true, wintun: true });
  assert.equal(state.stylesheet, 200);
   assert.equal(state.nodeInRenderer, false);
   assert.deepEqual(state.legacyImport, { path: '/ws/chat', allowInsecure: true, sharedPath: '/ws/chat', sharedInsecure: '1' });
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
   console.log('[smoke] Dashboard, nine views, onboarding, QR tools, legacy imports and native resources passed:', JSON.stringify(state));
  if (process.argv.includes('--installer-cleanup')) {
    await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('build/installer-cleanup.ps1'), '-InstallDir', path.dirname(executable),
    ], { windowsHide: true });
  } else {
    await call('Runtime.evaluate', { expression: 'setTimeout(() => window.close(), 50); true', returnByValue: true });
  }
  const outcome = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error('Window close did not finish controller cleanup'); })]);
  assert.equal(outcome[0], 0, output);
  await assert.rejects(fetch(`${base}/api/init`, { signal: AbortSignal.timeout(1000) }), 'Controller must exit with its window');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'vpn-state.json'), 'utf8'));
  assert.equal(saved.onboardingCompleted, true);
  console.log('[smoke] Normal window close stopped the controller; preferences saved.');
} finally {
  websocket?.close();
  if (child.exitCode === null) {
    try {
      const initial = await (await fetch(`${base}/api/init`, { signal: AbortSignal.timeout(2000) })).json();
      await fetch(`${base}/api/shutdown`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DragonForce-Token': initial.apiToken },
        body: '{}', signal: AbortSignal.timeout(30000),
      });
      await exited;
    } catch (error) { console.error('[smoke] Cleanup:', error.message, output); }
  }
  if (child.exitCode !== null) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
