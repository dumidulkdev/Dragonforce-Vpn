import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

async function desktop(options: { portable?: string; elevationError?: Error; lock?: boolean; platform?: NodeJS.Platform } = {}) {
  const root = path.resolve('.');
  const dataDir = path.join(root, 'test-data');
  const controls: any = {
    messages: [], errors: [], quit: false, locks: 0, released: 0,
    appUserModelIds: [], desktopNames: [], execCalls: 0,
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 999, exitCode: null, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(),
    send(message: any, callback?: (error?: Error) => void) { controls.messages.push(message); callback?.(); },
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getAppPath: () => path.join(root, 'resources/app.asar'), getPath: () => root,
    getVersion: () => '2.4.0', setPath() {}, setName() {},
    setAppUserModelId(value: string) { controls.appUserModelIds.push(value); },
    setDesktopName(value: string) { controls.desktopNames.push(value); },
    requestSingleInstanceLock() { controls.locks++; return options.lock !== false; },
    releaseSingleInstanceLock() { controls.released++; },
    whenReady: () => Promise.resolve(),
    quit() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('before-quit', event);
      if (!event.prevented) controls.quit = true;
    },
  });
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    });
    constructor(config: any) { super(); controls.window = this; controls.windowConfig = config; }
    isDestroyed() { return false; } isMinimized() { return false; }
    restore() {} show() {} focus() {} maximize() {} setTitle() {}
    async loadURL(url: string) { controls.url = url; }
  }
  const stubs: Record<string, any> = {
    electron: { app, BrowserWindow: Window, dialog: { showErrorBox(_title: string, message: string) { controls.errors.push(message); } }, Menu: { setApplicationMenu() {} }, shell: { openExternal: async () => {} } },
    'node:fs': { default: { mkdirSync() {}, appendFileSync() {}, writeFileSync() {} } },
    'node:child_process': {
      fork(file: string, _args: string[], config: any) { controls.fork = { file, config }; return child; },
      execFile(_exe: string, args: string[], _config: any, callback: any) {
        controls.execCalls++;
        controls.elevationScript = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
        callback(options.elevationError || null, '');
      },
    },
  };
  const context = vm.createContext({
    Buffer, URL, console, __dirname: path.join(root, 'dist-electron'),
    process: {
      argv: ['DragonForce-VPN.exe'], execPath: path.join(root, 'extracted/DragonForce-VPN.exe'),
      resourcesPath: path.join(root, 'resources'), arch: 'x64',
      platform: options.platform || 'win32',
      env: { VPN_DATA_DIR: dataDir, VPN_UI_PORT: '18765', PORTABLE_EXECUTABLE_FILE: options.portable },
    },
  });
  const entry = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync('src/main/desktop.ts', 'utf8')), { context });
  await entry.link(async name => {
    const values = stubs[name] || await import(name);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  const message = async (value: any) => {
    await Promise.all(child.listeners('message').map(listener => listener(value)));
  };
  return { controls, app, child, message, dataDir };
}

await test('desktop: packaged controller uses external native resources and writable user data', async () => {
  const d = await desktop();
  const config = d.controls.fork.config;
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(config.env.VPN_DATA_DIR, d.dataDir);
  assert.equal(config.env.VPN_BIN_DIR, path.resolve('resources/bin'));
  assert.match(config.env.VPN_APP_ROOT, /app\.asar$/);
  assert.equal(d.controls.window, undefined, 'the dashboard waits for its own controller');
  await d.message({ type: 'ready' });
  assert.equal(d.controls.url, 'http://127.0.0.1:18765');
  assert.equal(d.controls.windowConfig.webPreferences.nodeIntegration, false);
  assert.deepEqual(d.controls.appUserModelIds, ['com.dragonforce.vpn']);
  assert.equal(d.controls.window.listenerCount('session-end'), 1);
});

await test('desktop: Linux uses a desktop identity and rejects Windows elevation cleanly', async () => {
  const d = await desktop({ platform: 'linux' });
  assert.deepEqual(d.controls.appUserModelIds, []);
  assert.deepEqual(d.controls.desktopNames, ['dragonforce-vpn.desktop']);
  await d.message({ type: 'ready' });
  assert.equal(d.controls.window.listenerCount('session-end'), 0);
  await d.message({ type: 'relaunch-admin', id: 'linux-request' });
  assert.match(d.controls.messages.at(-1).error, /polkit integration is pending/);
  assert.equal(d.controls.execCalls, 0);
});

await test('desktop: closing waits for controller cleanup and a failed cleanup can be retried', async () => {
  const d = await desktop();
  await d.message({ type: 'ready' });
  let prevented = false;
  d.controls.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(d.controls.quit, false);
  assert.equal(d.controls.messages.at(-1).type, 'shutdown');
  await d.message({ type: 'shutdown-error', error: 'Route is still owned' });
  assert.equal(d.controls.quit, false);
  d.app.quit();
  assert.equal(d.controls.messages.filter((m: any) => m.type === 'shutdown').length, 2);
  d.child.emit('exit', 0, null);
  assert.equal(d.controls.quit, true);
});

await test('desktop: portable elevation relaunches the distributable, preserving data directory and UI port', async () => {
  const portable = "C:\\Release files\\User's VPN.exe";
  const d = await desktop({ portable });
  await d.message({ type: 'relaunch-admin', id: 'request' });
  assert.ok(d.controls.elevationScript.includes("C:\\Release files\\User''s VPN.exe"));
  assert.ok(d.controls.elevationScript.includes(`--vpn-data-dir=${d.dataDir}`));
  assert.ok(d.controls.elevationScript.includes('--vpn-ui-port=18765'));
  assert.doesNotMatch(d.controls.elevationScript, /extracted/);
  assert.equal(d.controls.released, 1);
  assert.equal(d.controls.messages.at(-1).error, undefined);
  assert.equal(d.controls.quit, false, 'the replacement must request network cleanup');
});

await test('desktop: cancelled UAC restores the instance lock and keeps the controller alive', async () => {
  const d = await desktop({ elevationError: new Error('UAC cancelled') });
  await d.message({ type: 'relaunch-admin', id: 'request' });
  assert.equal(d.controls.locks, 2);
  assert.match(d.controls.messages.at(-1).error, /UAC cancelled/);
  assert.equal(d.controls.messages.some((m: any) => m.type === 'shutdown'), false);
  assert.equal(d.controls.quit, false);
});

await test('desktop: a second launch does not create another controller', async () => {
  const d = await desktop({ lock: false });
  assert.equal(d.controls.fork, undefined);
  assert.equal(d.controls.quit, true);
});
