import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backend, deferred } from './helpers/backend.mts';

await test('usage reset discards old cumulative counters and counts only subsequent traffic', async () => {
  const b = await backend();
  await b.call('connect');
  b.controls.stats = { upBytes: 100, downBytes: 500 };
  await b.tick();
  assert.equal((await b.state()).data.totalDown, 500);
  // Include unpolled traffic before reset as well.
  b.controls.stats = { upBytes: 120, downBytes: 600 };
  await b.api('/api/usage/reset', {});
  await b.tick();
  assert.equal((await b.state()).data.totalDown, 0);
  assert.equal((await b.state()).data.totalUp, 0);
  b.controls.stats = { upBytes: 130, downBytes: 650 };
  await b.tick();
  const state = await b.state();
  assert.equal(state.data.totalDown, 50);
  assert.equal(state.data.totalUp, 10);
  assert.equal(state.data.usageHistory.perServer.A.downBytes, 50);
  await b.call('disconnect');
});

await test('a stale poll cannot restore history after reset or overwrite a new connection', async () => {
  const b = await backend();
  await b.call('connect');
  b.controls.stats = { upBytes: 100, downBytes: 500 };
  const gate = deferred();
  const entered = deferred();
  b.controls.statsGate = gate.promise;
  b.controls.statsEntered = () => entered.resolve();
  const pending = b.tick();
  await entered.promise;
  b.controls.statsGate = null;
  await b.api('/api/usage/reset', {});
  gate.resolve();
  await pending;
  assert.equal((await b.state()).data.totalDown, 0);
  await b.call('disconnect');
});

await test('Shield rejects disconnected verification and never records simulated blocks', async () => {
  const b = await backend();
  assert.equal((await b.api('/api/adblock/test', {})).ok, false);
  assert.equal(b.controls.verifyCalls || 0, 0);
  const preview = await b.api('/api/adblock/check-domain', { domain: 'ads.youtube.com' });
  assert.equal(preview.blocked, true);
  assert.equal(preview.simulation, true);
  assert.equal((await b.state()).data.adblock.totalBlocked, 0);
  await b.call('connect');
  const result = await b.api('/api/adblock/test', {});
  assert.equal(result.ok, false);
  assert.equal(result.blockedCount, 0);
  assert.equal((await b.state()).data.adblock.totalBlocked, 0);
  await b.call('disconnect');
});
