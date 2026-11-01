import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backend, deferred, makeNode, seed } from './helpers/backend.mts';

for (const kind of ['standalone', 'electron'] as const) {
  await test(`${kind}: profile and global insecure TLS settings pin the certificate on every connection`, async () => {
    for (const useDefault of [false, true]) {
      const server = { ...makeNode('A'), sni: 'front.example', allowInsecure: !useDefault };
      const b = await backend(kind, { ...seed(), servers: [server], allowInsecureDefault: useDefault, routingMode: 'tun' });
      for (const pin of ['ab'.repeat(32), 'cd'.repeat(32)]) {
        b.controls.certFingerprint = pin;
        assert.equal((await b.call('connect')).ok, true);
        assert.equal(b.controls.configOptions.pinnedCertSha256, pin);
        assert.equal(b.controls.configOptions.resolvedServerAddress, '203.0.113.1');
      }
      assert.deepEqual(b.controls.certCalls, [
        { host: '203.0.113.1', port: 443, servername: 'front.example' },
        { host: '203.0.113.1', port: 443, servername: 'front.example' },
      ]);
      await b.call('disconnect');
    }
  });

  await test(`${kind}: a failed certificate probe stops before enabling networking`, async () => {
    const b = await backend(kind, { ...seed(), allowInsecureDefault: true });
    const result = await b.call('connect');
    assert.equal(result.ok, false);
    assert.match(result.error, /TLS certificate/);
    assert.equal(b.controls.starts, 0);
    assert.equal(b.controls.proxy, false);
    assert.equal(b.controls.tun, false);
    assert.equal((await b.state()).status.connected, false);
  });

  await test(`${kind}: disconnect cancels a pending certificate probe without starting Xray later`, async () => {
    const b = await backend(kind, { ...seed(), allowInsecureDefault: true });
    const gate = deferred();
    const entered = deferred();
    b.controls.certGate = gate.promise;
    b.controls.certEntered = () => entered.resolve();
    b.controls.certFingerprint = 'ab'.repeat(32);
    const connecting = b.call('connect');
    await entered.promise;
    await b.call('disconnect');
    assert.equal((await connecting).ok, false);
    gate.resolve();
    assert.equal((await b.state()).status.lastError, null);
    assert.equal(b.controls.starts, 0);
    assert.equal(b.controls.proxy, false);
  });

  await test(`${kind}: disconnect cancels pending DNS without waiting for it`, async () => {
    const b = await backend(kind, { ...seed(), routingMode: 'tun' });
    const dns = deferred();
    const entered = deferred();
    b.controls.resolveGate = dns.promise;
    b.controls.resolveEntered = () => entered.resolve();
    const connect = b.call('connect');
    await entered.promise;
    await b.call('disconnect');
    assert.equal((await connect).ok, false);
    dns.resolve();
    const state = await b.state();
    assert.equal(state.status.connected, false);
    assert.equal(state.status.connecting, false);
    assert.equal(state.status.lastError, null);
    assert.equal(b.controls.starts, 0);
    assert.equal(b.controls.proxy, false);
  });

  await test(`${kind}: cancellation during process start cleans up before the next connection`, async () => {
    const b = await backend(kind);
    const gate = deferred();
    const entered = deferred();
    b.controls.startGate = gate.promise;
    b.controls.startEntered = () => entered.resolve();
    const oldConnect = b.call('connect');
    await entered.promise;
    const disconnect = b.call('disconnect');
    const nextConnect = b.call('connect', { serverId: 'B' });
    b.controls.startGate = null;
    gate.resolve();
    assert.equal((await oldConnect).ok, false);
    await disconnect;
    assert.equal((await nextConnect).ok, true);
    assert.equal(b.controls.actualServer, 'B');
    assert.equal((await b.state()).status.activeServerId, 'B');
    await b.call('disconnect');
  });

  await test(`${kind}: deleting an active subscription stops the old tunnel`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    assert.equal((await b.call('delete-subscription', { subId: 'sub-A' })).ok, true);
    const state = await b.state();
    assert.equal(state.status.connected, false);
    assert.equal(state.status.activeServerId, 'B');
    assert.equal(b.controls.actualServer, null);
  });

  await test(`${kind}: subscription refresh applies changed settings or disconnects a removed server`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    b.controls.feed = { subscription: seed().subscriptions[0], nodes: [{ ...makeNode('new-id'), path: '/changed' }] };
    assert.equal((await b.call('refresh-subscription', { subId: 'sub-A' })).ok, true);
    assert.equal(b.controls.starts, 2);
    assert.equal(b.controls.actualServer, 'A');
    assert.equal((await b.state()).status.connected, true);

    b.controls.feed.nodes[0].address = 'replacement.qa.example';
    await b.call('refresh-subscription', { subId: 'sub-A' });
    assert.equal((await b.state()).status.connected, false);
    assert.equal(b.controls.actualServer, null);
    assert.equal((await b.state()).status.activeServerId, 'B');
  });

  await test(`${kind}: unrelated subscriptions do not interrupt a connection`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    await b.call('delete-subscription', { subId: 'sub-B' });
    assert.equal(b.controls.starts, 1);
    assert.equal(b.controls.actualServer, 'A');
    assert.equal((await b.state()).status.connected, true);
    await b.call('disconnect');
  });

  await test(`${kind}: refreshed profiles sharing an endpoint retain distinct identities and the active transport`, async () => {
    const tcp = makeNode('tcp');
    const ws = { ...makeNode('ws'), network: 'ws', path: '/old' };
    const b = await backend(kind, { ...seed(), servers: [tcp, ws], activeServerId: ws.id });
    await b.call('connect');
    b.controls.feed = {
      subscription: seed().subscriptions[0],
      nodes: [{ ...ws, id: 'new-ws', path: '/updated' }, { ...tcp, id: 'new-tcp' }],
    };
    assert.equal((await b.call('refresh-subscription', { subId: 'sub-A' })).ok, true);
    const state = await b.state();
    assert.equal(new Set(state.data.servers.map((node: any) => node.id)).size, 2);
    assert.equal(state.status.activeServerId, 'ws');
    assert.equal(state.data.servers.find((node: any) => node.id === 'ws').path, '/updated');
    assert.equal(b.controls.actualServer, 'ws');
    assert.equal(state.status.connected, true);
    await b.call('disconnect');
  });

  await test(`${kind}: a late refresh cannot resurrect a deleted subscription`, async () => {
    const b = await backend(kind);
    const gate = deferred();
    const entered = deferred();
    b.controls.feed = { subscription: seed().subscriptions[0], nodes: [makeNode('C')] };
    b.controls.feedGate = gate.promise;
    b.controls.feedEntered = () => entered.resolve();
    const refresh = b.call('refresh-subscription', { subId: 'sub-A' });
    await entered.promise;
    await b.call('delete-subscription', { subId: 'sub-A' });
    gate.resolve();
    assert.equal((await refresh).ok, false);
    assert.equal((await b.state()).data.servers.some((node: any) => node.subscriptionId === 'sub-A'), false);
  });

  await test(`${kind}: terminal proxy follows reconnection and is restored on disconnect`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    assert.equal((await b.call('terminal-env', { enabled: true })).ok, true);
    await b.call('connect', { serverId: 'B' });
    assert.equal(b.controls.terminal, true);
    await b.call('disconnect');
    assert.equal(b.controls.terminal, false);
    assert.equal((await b.state()).status.terminalEnvActive, false);
  });

  await test(`${kind}: invalid ports are rejected without disconnecting or saving them`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    for (const httpPort of [10085, 10808, 0, -1, 65536, 10809.5, '10810']) {
      const result = await b.call('settings', { httpPort });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal((await b.state()).data.httpPort, 10809);
      assert.equal((await b.state()).status.connected, true);
    }
    assert.equal(b.controls.starts, 1);
    await b.call('disconnect');
  });

  await test(`${kind}: failed settings reconnect returns an error and restores previous settings`, async () => {
    const b = await backend(kind);
    await b.call('connect');
    b.controls.failStart = true;
    const result = await b.call('settings', { httpPort: 23456 });
    assert.equal(result.ok, false);
    assert.match(result.error, /bind failure/);
    const state = await b.state();
    assert.equal(state.data.httpPort, 10809);
    assert.equal(state.status.httpPort, 10809);
    assert.equal(state.status.connected, false);
  });

  for (const component of ['Xray', 'TUN']) {
    await test(`${kind}: unexpected ${component} exit restores all network resources and reports failure`, async () => {
      const b = await backend(kind, { ...seed(), routingMode: 'tun' });
      await b.call('connect');
      await b.call('terminal-env', { enabled: true });
      if (component === 'Xray') {
        b.controls.running = false;
        await b.controls.xrayExit(1);
      } else {
        b.controls.tun = false;
        await b.controls.tunExit(2);
      }
      const state = await b.state();
      assert.equal(state.status.connected, false);
      assert.equal(state.status.connectedAt, null);
      assert.equal(state.status.terminalEnvActive, false);
      assert.match(state.status.lastError, new RegExp(component + ' process exited unexpectedly'));
      assert.equal(b.controls.running, false);
      assert.equal(b.controls.tun, false);
      assert.equal(b.controls.proxy, false);
      assert.equal(b.controls.terminal, false);
    });
  }

  await test(`${kind}: unexpected-exit cleanup completes before a subsequent connection starts`, async () => {
    const b = await backend(kind, { ...seed(), routingMode: 'tun' });
    await b.call('connect');
    const gate = deferred();
    const entered = deferred();
    b.controls.tunStopGate = gate.promise;
    b.controls.tunStopEntered = () => entered.resolve();
    b.controls.tun = false;
    const cleanup = b.controls.tunExit(1);
    await entered.promise;
    const next = b.call('connect', { serverId: 'B' });
    assert.equal(b.controls.starts, 1);
    b.controls.tunStopGate = null;
    gate.resolve();
    await cleanup;
    assert.equal((await next).ok, true);
    assert.equal(b.controls.actualServer, 'B');
    assert.equal((await b.state()).status.lastError, null);
    await b.call('disconnect');
  });

  await test(`${kind}: routing mode changes cancel a pending connection and apply consistently`, async () => {
    const b = await backend(kind, { ...seed(), routingMode: 'tun' });
    const gate = deferred();
    const entered = deferred();
    b.controls.resolveGate = gate.promise;
    b.controls.resolveEntered = () => entered.resolve();
    const connecting = b.call('connect');
    await entered.promise;
    const result = await b.call('routing-mode', { mode: 'system_proxy' });
    gate.resolve();
    assert.equal((await connecting).ok, false);
    assert.equal(result.ok, true);
    assert.equal((await b.state()).status.routingMode, 'system_proxy');
    assert.equal(b.controls.tun, false);
    assert.equal(b.controls.proxy, true);
    await b.call('disconnect');
  });
}

await test('Electron quit is prevented until all network restoration has completed', async () => {
  const b = await backend('electron', { ...seed(), routingMode: 'tun' });
  await b.call('connect');
  await b.call('terminal-env', { enabled: true });
  const gate = deferred();
  const entered = deferred();
  const quit = deferred();
  b.controls.tunStopGate = gate.promise;
  b.controls.tunStopEntered = () => entered.resolve();
  b.controls.quitDone = () => quit.resolve();
  let prevented = false;
  b.signals.get('before-quit')!({ preventDefault() { prevented = true; } });
  await entered.promise;
  assert.equal(prevented, true);
  assert.equal(Boolean(b.controls.quit), false);
  gate.resolve();
  await quit.promise;
  assert.equal(b.controls.running, false);
  assert.equal(b.controls.proxy, false);
  assert.equal(b.controls.terminal, false);
  assert.equal(b.controls.tun, false);
});

for (const [route, patch, field] of [
  ['/api/adblock/config', { enabled: false }, 'adblock'],
  ['/api/split-tunnel/config', { mode: 'vpn_only' }, 'splitTunnel'],
  ['/api/routing-mode', { mode: 'tun' }, 'routingMode'],
] as const) {
  await test(`${route}: failed reconnection returns an error and rolls back preferences`, async () => {
    const b = await backend();
    await b.call('connect');
    const before = JSON.stringify((await b.state()).data[field]);
    b.controls.failStart = true;
    const result = await b.api(route, patch);
    assert.equal(result.ok, false);
    assert.match(result.error, /bind failure/);
    assert.equal(JSON.stringify((await b.state()).data[field]), before);
    assert.equal((await b.state()).status.connected, false);
  });
}

await test('standalone: failed elevation preserves the current controller and connection', async () => {
  const b = await backend();
  await b.call('connect');
  b.controls.allowElevation = true;
  b.controls.elevationError = new Error('User cancelled elevation');
  const result = await b.call('relaunch-admin');
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled elevation/);
  assert.equal((await b.state()).status.connected, true);
  assert.equal(b.controls.proxy, true);
  assert.equal(b.controls.running, true);
  assert.equal(Boolean(b.controls.exited), false);
  await b.call('disconnect');
});

await test('standalone: controller takeover initializes saved state exactly once after port release', async () => {
  const b = await backend('standalone', seed(), { occupiedPort: true });
  assert.equal(b.controls.listenAttempts, 2);
  assert.equal(b.controls.previousStopped, true);
  assert.equal(b.controls.stateReads, 1);
  const state = await b.state();
  assert.equal(state.logs.filter((log: any) => log.message.includes('Xray VPN Client ready.')).length, 1);
  assert.equal(state.data.activeServerId, 'A');
});

await test('standalone: elevation hands cleanup to the authenticated replacement controller', async () => {
  const b = await backend();
  await b.call('connect');
  b.controls.allowElevation = true;
  const gate = deferred();
  const entered = deferred();
  b.controls.elevationGate = gate.promise;
  b.controls.elevationEntered = () => entered.resolve();
  const pending = b.call('relaunch-admin');
  await entered.promise;
  assert.equal((await b.state()).status.connected, true);
  gate.resolve();
  assert.equal((await pending).ok, true);
  const command = b.controls.elevationArgs[1].at(-1);
  assert.doesNotMatch(command, /\.bat\b/i);
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(encoded, 'the elevated process must receive its launch context');
  const bootstrap = Buffer.from(encoded, 'base64').toString('utf16le');
  for (const key of ['VPN_APP_ROOT', 'VPN_BIN_DIR', 'VPN_DATA_DIR', 'VPN_UI_PORT']) {
    assert.ok(bootstrap.includes(`$env:${key} = `), `${key} must survive elevation`);
  }
  assert.ok(bootstrap.includes(process.execPath.replace(/'/g, "''")));
  assert.equal((await b.state()).status.connected, true);
  assert.equal((await b.call('shutdown')).ok, true);
  assert.equal(b.controls.proxy, false);
  assert.equal(b.controls.running, false);
});

await test('standalone: graceful process exit waits for TUN and proxy restoration', async () => {
  const b = await backend('standalone', { ...seed(), routingMode: 'tun' });
  await b.call('connect');
  await b.call('terminal-env', { enabled: true });
  const gate = deferred();
  const entered = deferred();
  b.controls.tunStopGate = gate.promise;
  b.controls.tunStopEntered = () => entered.resolve();
  const shutdown = b.signals.get('SIGTERM')!();
  await entered.promise;
  assert.equal(Boolean(b.controls.exited), false);
  gate.resolve();
  await shutdown;
  assert.equal(b.controls.exited, true);
  for (const key of ['running', 'tun', 'proxy', 'terminal']) assert.equal(b.controls[key], false, key);
});
