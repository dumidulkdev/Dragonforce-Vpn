import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

async function helperModule(helper: { uid: number; mode: number; exists?: boolean }, spawnImpl: (...args: any[]) => any = () => { throw new Error('spawn blocked'); }) {
  const regular = new Set(['/helper', '/pkexec', '/ip', '/usr/bin/pkexec', '/usr/bin/ip', '/usr/lib/dragonforce-vpn/dragonforce-net-helper']);
  const fakeFs = {
    constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
    statSync(file: string) {
      if (file === '/tun' || file === '/dev/net/tun') return { isFile: () => false, isCharacterDevice: () => true, uid: 0, mode: 0o666 };
      const isHelper = file === '/helper' || file === '/usr/lib/dragonforce-vpn/dragonforce-net-helper';
      if (isHelper && helper.exists === false) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (regular.has(file)) return { isFile: () => true, isCharacterDevice: () => false, uid: isHelper ? helper.uid : 0, mode: isHelper ? helper.mode : 0o755 };
      throw new Error(`Unexpected stat: ${file}`);
    },
    accessSync() {},
  };
  const context = vm.createContext({ Buffer, process: { platform: 'linux', env: {} }, setTimeout, clearTimeout });
  const entry = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync('src/main/linuxNetworkHelper.ts', 'utf8')), { context });
  await entry.link(async name => {
    const values = name === 'node:fs' ? { default: fakeFs }
      : name === 'node:child_process' ? { spawn: spawnImpl }
      : await import(name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  return entry.namespace as any;
}

await test('Linux TUN capability requires a secure root-owned helper', async () => {
  const api = await helperModule({ uid: 0, mode: 0o755 });
  const capability = api.getLinuxTunCapability({
    platform: 'linux', helperPath: '/helper', pkexecPath: '/pkexec', ipPath: '/ip', tunDevicePath: '/tun',
  });
  assert.equal(capability.available, true);
  assert.equal(capability.privilegeMode, 'polkit');
});

await test('Linux helper client uses one pkexec process and a fixed typed protocol', async () => {
  const controls: any = { spawn: null, actions: [] };
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
    stdin: {
      write(line: string, callback: (error?: Error) => void) {
        const request = JSON.parse(line);
        controls.actions.push(request.action);
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ action: request.action, ok: true }) + '\n');
          if (request.action === 'cleanup') child.emit('exit', 0);
        });
        callback?.();
      },
      end() {},
    },
    kill() { child.emit('exit', 0); return true; },
  });
  const api = await helperModule({ uid: 0, mode: 0o755 }, (file: string, args: string[]) => {
    controls.spawn = { file, args };
    queueMicrotask(() => child.stdout.emit('data', '{"action":"ready","ok":true}\n'));
    return child;
  });
  const client = new api.LinuxNetworkHelperClient(() => {});
  await client.start();
  await client.prepare('12345678-1234-1234-1234-123456789abc', '203.0.113.1', '192.0.2.1', 'eth0');
  await client.activate();
  await client.deactivate();
  await client.cleanup();
  assert.equal(controls.spawn.file, '/usr/bin/pkexec');
  assert.equal(Array.from(controls.spawn.args).join('|'), '/usr/lib/dragonforce-vpn/dragonforce-net-helper');
  assert.equal(controls.actions.join('|'), 'prepare|activate|deactivate|cleanup');
});

await test('Linux TUN capability rejects missing, user-owned, or writable helpers', async () => {
  for (const fixture of [
    { uid: 0, mode: 0o755, exists: false },
    { uid: 1000, mode: 0o755 },
    { uid: 0, mode: 0o775 },
  ]) {
    const api = await helperModule(fixture);
    const capability = api.getLinuxTunCapability({
      platform: 'linux', helperPath: '/helper', pkexecPath: '/pkexec', ipPath: '/ip', tunDevicePath: '/tun',
    });
    assert.equal(capability.available, false);
    assert.ok(capability.reason);
  }
});
