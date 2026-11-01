import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

async function virtualRegistry(initial: Record<string, any>, platform: NodeJS.Platform = 'win32') {
  const registry = new Map(Object.entries(structuredClone(initial)));
  const controls = { failOn: '', commands: [] as Array<{ file: string; args: string[] }>, logs: [] as string[] };
  const keyOf = (key: string, name: string) => (key + '/' + name).toLowerCase();
  function execFile(file: string, args: string[], ...rest: any[]) {
    const done = rest.at(-1);
    controls.commands.push({ file, args });
    let stdout = '';
    if (file === 'powershell.exe' && args.at(-1)!.includes('OpenSubKey')) {
      const script = args.at(-1)!;
      const key = 'HKCU\\' + /OpenSubKey\('([^']+)'\)/.exec(script)![1];
      const names = /foreach \(\$name in @\(([^)]+)\)\)/.exec(script)![1].match(/'([^']+)'/g)!.map(name => name.slice(1, -1));
      stdout = JSON.stringify(Object.fromEntries(names.map(name => [name, registry.get(keyOf(key, name)) ?? null])));
    } else if (file === 'reg.exe') {
      const name = args[args.indexOf('/v') + 1];
      if (controls.failOn === name) {
        controls.failOn = '';
        done(new Error('Simulated registry write failure'));
        return;
      }
      const key = keyOf(args[1], name);
      if (args[0] === 'delete') registry.delete(key);
      else {
        const type = args[args.indexOf('/t') + 1];
        const value = args[args.indexOf('/d') + 1];
        const kinds: Record<string, string> = { REG_DWORD: 'DWord', REG_SZ: 'String', REG_EXPAND_SZ: 'ExpandString', REG_QWORD: 'QWord' };
        registry.set(key, { kind: kinds[type], value: type === 'REG_DWORD' ? Number(value) : value });
      }
    }
    done(null, { stdout, stderr: '' });
  }
  const context = vm.createContext({
    process: { platform },
    console: { log(message: string) { controls.logs.push(message); } },
  });
  const entry = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync('src/main/systemProxy.ts', 'utf8')), { context });
  await entry.link(async name => {
    const values = name === 'node:child_process' ? { execFile } : await import(name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  return { api: entry.namespace as any, registry, controls };
}

const prefix = 'hkcu\\software\\microsoft\\windows\\currentversion\\internet settings/';
const existing = {
  [prefix + 'autodetect']: { kind: 'DWord', value: 1 },
  [prefix + 'proxyenable']: { kind: 'DWord', value: 1 },
  [prefix + 'proxyserver']: { kind: 'String', value: 'corporate.example:8080' },
  [prefix + 'proxyoverride']: { kind: 'String', value: '<local>;intranet' },
};

await test('Windows proxy restores original values after repeated enable and does not change unowned settings', async () => {
  const { api, registry } = await virtualRegistry(existing);
  await api.disableWindowsSystemProxy();
  assert.deepEqual(Object.fromEntries(registry), existing);
  await api.enableWindowsSystemProxy(10809);
  await api.enableWindowsSystemProxy(20809);
  await api.disableWindowsSystemProxy();
  assert.deepEqual(Object.fromEntries(registry), existing);
});

await test('Windows proxy restores absent values and rolls back a partial enable failure', async () => {
  const { api, registry, controls } = await virtualRegistry({});
  controls.failOn = 'ProxyOverride';
  await assert.rejects(api.enableWindowsSystemProxy(10809), /Simulated/);
  assert.equal(registry.size, 0);
  await api.enableWindowsSystemProxy(10809);
  await api.disableWindowsSystemProxy();
  assert.equal(registry.size, 0);
});

await test('terminal cleanup restores existing values and expandable-string types', async () => {
  const initial = {
    'hkcu\\environment/http_proxy': { kind: 'ExpandString', value: 'http://%CORP_PROXY%:8080' },
    'hkcu\\environment/no_proxy': { kind: 'String', value: 'intranet' },
  };
  const { api, registry } = await virtualRegistry(initial);
  await api.setWindowsTerminalProxyEnv(true, 10809, 10808);
  await api.setWindowsTerminalProxyEnv(true, 20809, 20808);
  await api.setWindowsTerminalProxyEnv(false, 20809, 20808);
  assert.deepEqual(Object.fromEntries(registry), initial);
});

await test('platform wrappers delegate to the existing Windows implementations', async () => {
  const { api, registry } = await virtualRegistry(existing);
  assert.equal((await api.enableSystemProxy(10809)).applied, true);
  assert.equal(registry.get(prefix + 'proxyserver')?.value, '127.0.0.1:10809');
  assert.equal((await api.disableSystemProxy()).applied, false);
  assert.deepEqual(Object.fromEntries(registry), existing);

  assert.equal((await api.enableTerminalProxy(10809, 10808)).applied, true);
  assert.equal((await api.disableTerminalProxy(10809, 10808)).applied, false);
});

await test('Linux wrappers leave Registry and terminal environment untouched', async () => {
  const { api, registry, controls } = await virtualRegistry(existing, 'linux');
  const before = Object.fromEntries(registry);

  const system = await api.enableSystemProxy(10809);
  const terminal = await api.enableTerminalProxy(10809, 10808);
  const disabledSystem = await api.disableSystemProxy();
  const disabledTerminal = await api.disableTerminalProxy(10809, 10808);

  assert.equal(system.applied, false);
  assert.match(system.message, /Local Proxy mode is active/);
  assert.equal(terminal.applied, false);
  assert.match(terminal.message, /were not changed/);
  assert.equal(disabledSystem.applied, false);
  assert.equal(disabledTerminal.applied, false);
  assert.deepEqual(Object.fromEntries(registry), before);
  assert.deepEqual(controls.commands, []);
  assert.equal(controls.logs.length, 2);
});
