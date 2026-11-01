import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseShareLink } from '../src/main/parser.ts';
import { deferred } from './helpers/backend.mts';

async function virtualProcesses(moduleName: 'tunManager' | 'xrayRunner') {
  const controls: any = { autoExit: true, spawnError: '', failAdd: '', failDelete: '', commands: [], routes: new Map(), children: [], exits: [], flushes: 0 };
  class Child extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid: number | undefined = 100 + controls.children.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    exit(code: number | null = 0, signal: string | null = null) {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
    }
    kill() {
      this.killed = true;
      if (controls.autoExit) queueMicrotask(() => this.exit(null, 'SIGTERM'));
      return true;
    }
  }
  const fakeSpawn = () => {
    const child = new Child();
    controls.children.push(child);
    if (controls.spawnError) {
      child.pid = undefined;
      queueMicrotask(() => child.emit('error', new Error(controls.spawnError)));
    }
    return child;
  };
  const fakeExec = (file: string, args: string[], ...rest: any[]) => {
    const done = rest.at(-1);
    controls.commands.push({ file, args });
    void (async () => {
      if (file === 'ipconfig.exe') controls.flushes++;
      if (file !== 'powershell.exe') return '';
      const script = args.at(-1)!;
      if (script.includes('New-NetRoute') || script.includes('Remove-NetRoute')) {
        const [, prefix, index, gateway] = /-DestinationPrefix '([^']+)' -InterfaceIndex (\d+) -NextHop '([^']+)'/.exec(script)!;
        const key = `${prefix}|${gateway}|${index}`;
        if (script.includes('New-NetRoute')) {
          if (controls.routeGate && controls.gatedPrefix === prefix) {
            controls.routeEntered?.();
            await controls.routeGate;
          }
          if (controls.failAdd === prefix) throw new Error(`Cannot install route ${prefix}`);
          if (controls.routes.has(key)) return 'existing';
          controls.routes.set(key, 'vpn-owned');
          return 'added';
        }
        if (controls.failDelete === prefix) throw new Error(`Cannot remove route ${prefix}`);
        controls.routes.delete(key);
        return '';
      }
      if (script.includes("-DestinationPrefix '::/0'")) return 'fe80::1|Wi-Fi|7';
      if (script.includes("-DestinationPrefix '0.0.0.0/0'")) return '192.0.2.1|Wi-Fi|7';
      if (script.includes('Get-NetAdapter -Name')) return '42';
      throw new Error(`Unexpected command: ${script}`);
    })().then(stdout => done(null, { stdout, stderr: '' }), done);
  };
  const sourcePath = path.resolve(`src/main/${moduleName}.ts`);
  const context = vm.createContext({
    Buffer, URL, AbortController,
    process: { platform: 'win32', env: {} },
    setTimeout: (callback: any, ms: number) => setTimeout(callback, Math.min(ms, 5)),
    clearTimeout,
  });
  const entry = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(sourcePath, 'utf8')), { context });
  await entry.link(async name => {
    const values = name === 'node:fs'
      ? { default: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} } }
      : name === 'node:child_process' ? { spawn: fakeSpawn, execFile: fakeExec }
      : name === './binaries.ts' ? {
        nativeBinaryNames: () => ({ xray: 'xray.exe', tun2socks: 'tun2socks.exe', wintun: 'wintun.dll' }),
        resolveNativeBinaries: () => ({
          xrayPath: path.resolve('virtual/bin/xray.exe'), tun2socksPath: null, wintunPath: null,
          geoipPath: null, geositePath: null, xrayAssetDir: null,
        }),
      }
      : await import(name.startsWith('node:') ? name : new URL(name, pathToFileURL(sourcePath)).href);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  const api = entry.namespace as any;
  const onExit = (code: number | null) => controls.exits.push(code);
  const runner = moduleName === 'tunManager' ? new api.TunManager(() => {}, onExit) : new api.XrayRunner('virtual/bin', 'virtual/data', () => {}, onExit);
  return { runner, controls };
}

await test('TUN captures both IPv4 and IPv6 and restores only routes it created', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  const original = new Map([
    ['203.0.113.1/32|192.0.2.1|7', 'user-owned server route'],
    ['0.0.0.0/1|192.0.2.254|9', 'unrelated adapter route'],
    ['::/0|fe80::1|7', 'physical IPv6 default'],
  ]);
  controls.routes = new Map(original);
  await runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1']);
  for (const route of ['0.0.0.0/1|198.18.0.1|42', '128.0.0.0/1|198.18.0.1|42', '::/1|::|42', '8000::/1|::|42']) {
    assert.equal(controls.routes.get(route), 'vpn-owned');
  }
  assert.ok(controls.commands.some((cmd: any) => cmd.file === 'netsh.exe' && cmd.args.includes('fdfe:dcba:9876::1/64')));
  assert.equal(runner.isRunning(), true);
  await runner.stop();
  assert.deepEqual(controls.routes, original);
  assert.equal(runner.isRunning(), false);
  assert.deepEqual(controls.exits, []);
  assert.ok(controls.flushes >= 2);
});

await test('an IPv6 capture failure rolls back partial TUN setup', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  controls.failAdd = '8000::/1';
  await assert.rejects(runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1']), /Cannot install route/);
  assert.equal(controls.routes.size, 0);
  assert.equal(runner.isRunning(), false);
  assert.equal(controls.children[0].killed, true);
});

await test('IPv6 VPN endpoints receive a physical /128 bypass route', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  await runner.start('virtual/bin', 10808, '2001:db8::99', ['2001:db8::99']);
  assert.equal(controls.routes.get('2001:db8::99/128|fe80::1|7'), 'vpn-owned');
  await runner.stop();
  assert.equal(controls.routes.size, 0);
});

await test('unexpected TUN exit propagates and cleanup still removes routes and flushes DNS', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  await runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1']);
  controls.children[0].exit(7);
  assert.deepEqual(controls.exits, [7]);
  assert.equal(runner.isRunning(), false);
  await runner.stop();
  assert.equal(controls.routes.size, 0);
  assert.ok(controls.flushes >= 2);
});

await test('route cleanup errors surface, retain ownership, and can be retried', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  await runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1']);
  controls.failDelete = '::/1';
  await assert.rejects(runner.stop(), /Cannot remove route ::\/1/);
  assert.equal(controls.routes.size, 1);
  controls.failDelete = '';
  await runner.stop();
  assert.equal(controls.routes.size, 0);
});

await test('cancelling TUN waits for an in-flight route mutation before rollback', async () => {
  const { runner, controls } = await virtualProcesses('tunManager');
  const gate = deferred();
  const entered = deferred();
  controls.gatedPrefix = '203.0.113.1/32';
  controls.routeGate = gate.promise;
  controls.routeEntered = () => entered.resolve();
  const controller = new AbortController();
  const pending = runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1'], undefined, controller.signal);
  const failed = assert.rejects(pending, /cancelled/);
  await entered.promise;
  controller.abort(new Error('Connection cancelled'));
  gate.resolve();
  await failed;
  assert.equal(controls.routes.size, 0);
  assert.equal(controls.children.length, 0);
});

const node = parseShareLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@vpn.example:443?security=tls');
for (const moduleName of ['xrayRunner', 'tunManager'] as const) {
  const start = (runner: any) => moduleName === 'xrayRunner'
    ? runner.start(node)
    : runner.start('virtual/bin', 10808, '203.0.113.1', ['203.0.113.1']);

  await test(`${moduleName}: process spawn errors are handled without crashing the controller`, async () => {
    const { runner, controls } = await virtualProcesses(moduleName);
    controls.spawnError = 'spawn EACCES';
    await assert.rejects(start(runner), /EACCES/);
    assert.equal(runner.isRunning(), false);
    assert.equal(controls.routes.size, 0);
  });

  await test(`${moduleName}: stop awaits process exit and late events cannot clear a replacement`, async () => {
    const { runner, controls } = await virtualProcesses(moduleName);
    await start(runner);
    const old = controls.children[0];
    controls.autoExit = false;
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    old.exit(null, 'SIGTERM');
    await stopping;
    controls.autoExit = true;
    await start(runner);
    old.emit('exit', 9);
    assert.equal(runner.isRunning(), true);
    assert.deepEqual(controls.exits, []);
    await runner.stop();
  });
}
