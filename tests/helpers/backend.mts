import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as parser from '../../src/main/parser.ts';
import * as shield from '../../src/main/adblockEngine.ts';

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const baseNode = parser.parseShareLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@qa.example:443?security=tls&type=tcp');
export const makeNode = (id: string, sub = 'sub-A') => ({ ...baseNode, id, name: id, subscriptionId: sub, geo: { ip: '203.0.113.1' } });
export const seed = () => ({
  servers: [makeNode('A'), makeNode('B', 'sub-B')],
  subscriptions: [{ id: 'sub-A', name: 'Feed A', url: 'https://qa.example/sub' }, { id: 'sub-B', name: 'Feed B', url: 'https://qa.example/sub-b' }],
  activeServerId: 'A', routingMode: 'system_proxy', onboardingCompleted: true,
});

/** Executes the actual entry point with virtual storage, processes, HTTP, timers and OS settings. */
export async function backend(
  kind: 'standalone' | 'electron' = 'standalone',
  initial: any = seed(),
  options: { occupiedPort?: boolean; platform?: NodeJS.Platform } = {}
) {
  const controls: any = {
    running: false, actualServer: null, starts: 0, stops: 0, proxy: false, terminal: false,
    tun: false, requests: 0, stats: { upBytes: 0, downBytes: 0 }, failStart: false,
    resolveGate: null, resolveEntered: null, startGate: null, startEntered: null, feed: null,
    listenAttempts: 0, stateReads: 0, previousStopped: false, certCalls: [],
  };
  const ready = deferred();
  const intervals = new Map<number, () => Promise<void>>();
  const signals = new Map<string, (...args: any[]) => any>();
  const ipc = new Map<string, (...args: any[]) => any>();
  const files = new Map<string, string>();
  let requestHandler: any;
  let timerId = 0;
  const root = path.resolve('.');
  const sourcePath = path.join(root, 'src/main', kind === 'standalone' ? 'standalone.ts' : 'index.ts');
  const fakeFs = {
    existsSync: (file: any) => String(file).endsWith('vpn-state.json') || /\.(exe|dll)$/.test(String(file)),
    readFileSync(file: any) {
      if (String(file).endsWith('vpn-state.json')) {
        controls.stateReads++;
        return JSON.stringify(initial);
      }
      throw new Error('Unexpected disk read in sandbox: ' + file);
    },
    mkdirSync() {},
    writeFileSync(file: any, bytes: any) { files.set(String(file), String(bytes)); },
    truncateSync() {},
    createReadStream() { throw new Error('Unexpected stream'); },
  };
  const server = Object.assign(new EventEmitter(), {
    listen(_port: any, _host: any, callback?: () => void) {
      if (callback) this.once('listening', callback);
      controls.listenAttempts++;
      if (options.occupiedPort && controls.listenAttempts === 1) {
        queueMicrotask(() => this.emit('error', Object.assign(new Error('Address in use'), { code: 'EADDRINUSE' })));
      } else {
        this.emit('listening');
        ready.resolve();
      }
      return this;
    },
    close(callback?: () => void) { callback?.(); }, closeAllConnections() {},
  });
  class FakeXray {
    constructor(_bin: any, _data: any, _log: any, onExit: any) { controls.xrayExit = onExit; }
    isRunning() { return controls.running; }
    async start(node: any, configOptions: any) {
      controls.starts++;
      controls.configOptions = configOptions;
      controls.startEntered?.();
      if (controls.startGate) await controls.startGate;
      if (controls.failStart) throw new Error('QA simulated port bind failure');
      controls.running = true;
      controls.actualServer = node.id;
    }
    async stop() { controls.stops++; controls.running = false; controls.actualServer = null; }
    async queryTrafficStats() {
      const result = { ...controls.stats };
      const gate = controls.statsGate;
      controls.statsEntered?.();
      if (gate) await gate;
      return result;
    }
  }
  class FakeTun {
    constructor(_log: any, onExit: any) { controls.tunExit = onExit; }
    isRunning() { return controls.tun; }
    async start() { controls.tun = true; }
    async stop() {
      controls.tunStopEntered?.();
      if (controls.tunStopGate) await controls.tunStopGate;
      controls.tun = false;
    }
  }
  class FakeWindow {
    webContents = { send() {} };
    isDestroyed() { return false; }
    maximize() {} show() {}
    async loadFile() { ready.resolve(); }
    async loadURL() { ready.resolve(); }
  }
  const stubs: Record<string, any> = {
    'node:fs': { default: fakeFs },
    'node:http': { default: {
      createServer(handler: any) { requestHandler = handler; return server; },
      request() { controls.requests++; throw new Error('Network blocked in sandbox'); },
    } },
    'node:child_process': {
      execFile(...args: any[]) {
        if (!controls.allowElevation) throw new Error('OS command blocked');
        controls.elevationArgs = args.slice(0, -1);
        controls.elevationEntered?.();
        const callback = args.at(-1);
        Promise.resolve(controls.elevationGate).then(() => callback(controls.elevationError || null, ''));
      },
      spawn() { throw new Error('Process spawn blocked'); },
    },
    'electron': {
      app: {
        getAppPath: () => root, getPath: () => path.join(root, 'data'),
        whenReady: () => Promise.resolve(), on: (name: string, callback: any) => signals.set(name, callback),
        quit() { controls.quit = true; controls.quitDone?.(); },
      },
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (name: string, callback: any) => ipc.set(name, callback) },
    },
    './adblockEngine.ts': { ...shield, AdBlockLogWatcher: class { reset() {} poll() { return 0; } } },
    './binaries.ts': {
      resolveNativeBinaries: () => ({
        xrayPath: path.join(root, 'resources/bin/xray.exe'),
        tun2socksPath: path.join(root, 'resources/bin/tun2socks.exe'),
        wintunPath: path.join(root, 'resources/bin/wintun.dll'),
        geoipPath: null,
        geositePath: null,
        xrayAssetDir: null,
      }),
    },
    './xrayRunner.ts': { XrayRunner: FakeXray, testProxyConnectivity: async () => ({ ok: true, latencyMs: 1 }) },
    './systemProxy.ts': {
      enableWindowsSystemProxy: async () => { controls.proxy = true; },
      disableWindowsSystemProxy: async () => { controls.proxy = false; },
      setWindowsTerminalProxyEnv: async (enabled: boolean) => { controls.terminal = enabled; },
      getTerminalProxyCommands: () => ({}),
    },
    './tunManager.ts': {
      TunManager: FakeTun, checkIsAdmin: async () => true,
      detectPhysicalGateway: async () => ({ interfaceName: 'QA', gatewayIp: '192.0.2.1', interfaceIndex: '7' }),
      resolveServerIpv4List: async () => {
        controls.resolveEntered?.();
        if (controls.resolveGate) await controls.resolveGate;
        return ['203.0.113.1'];
      },
      resolveServerAddresses: async () => {
        controls.resolveEntered?.();
        if (controls.resolveGate) await controls.resolveGate;
        return ['203.0.113.1'];
      },
    },
    './serverPing.ts': { clearServerPing() {}, measureServerPings: async () => {} },
    './controllerInstance.ts': { stopPreviousController: async () => { controls.previousStopped = true; } },
    './certPin.ts': { fetchLeafCertSha256: async (host: string, port: number, servername: string) => {
      controls.certCalls.push({ host, port, servername });
      controls.certEntered?.();
      if (controls.certGate) await controls.certGate;
      if (!controls.certFingerprint) throw new Error('Could not read the TLS certificate');
      return controls.certFingerprint;
    } },
    './geo.ts': { lookupGeo: async () => null, lookupExitGeo: async () => null },
    './speedTest.ts': { SpeedTest: class {} },
    './adblockVerification.ts': { verifyAdBlock: async () => {
      controls.verifyCalls = (controls.verifyCalls || 0) + 1;
      return controls.verificationResult || { ok: false, blockedCount: 0, error: 'No matching Xray log evidence' };
    } },
    './qrSystemBridge.ts': { captureWindowsScreen: async () => { throw new Error('Blocked'); }, readWindowsClipboard: async () => { throw new Error('Blocked'); } },
    './subscription.ts': { fetchSubscription: async () => {
      if (!controls.feed) throw new Error('Feed fixture missing');
      controls.feedEntered?.();
      if (controls.feedGate) await controls.feedGate;
      return structuredClone(controls.feed);
    } },
  };
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, performance, AbortController, console: { log() {}, error: console.error },
    __dirname: path.dirname(sourcePath),
    process: {
      env: { NO_OPEN_WINDOW: '1' }, cwd: () => root, execPath: process.execPath,
      platform: options.platform || 'win32', arch: 'x64',
      on: (name: string, callback: any) => signals.set(name, callback),
      exit() { controls.exited = true; },
    },
    setInterval(callback: any) { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval(id: number) { intervals.delete(id); },
    setTimeout() { return ++timerId; }, clearTimeout() {},
    fetch() { throw new Error('Network blocked in sandbox'); },
  });
  const entry = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(sourcePath, 'utf8')), {
    context, identifier: pathToFileURL(sourcePath).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(sourcePath).href; },
  });
  await entry.link(async name => {
    const values = stubs[name] || await import(name.startsWith('node:') ? name : new URL(name, pathToFileURL(sourcePath)).href);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  await ready.promise;
  let apiToken = '';
  const api = async (route: string, body?: any, headers: any = {}) => {
    let result: any;
    const req = {
      url: route, method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:17890', origin: 'http://127.0.0.1:17890', 'content-type': 'application/json', 'x-dragonforce-token': apiToken, ...headers },
      on() {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    const res = {
      code: 200, setHeader() {}, writeHead(code: number) { this.code = code; },
      end(text: string) { result = { httpStatus: this.code, ...JSON.parse(text) }; },
    };
    await requestHandler(req, res);
    if (result?.apiToken) apiToken = result.apiToken;
    return result;
  };
  const call = async (name: string, body?: any) => {
    if (kind === 'standalone') return api('/api/' + name, name === 'init' ? undefined : body ?? {});
    const mappings: Record<string, [string, any[]]> = {
      init: ['get-initial-data', []], connect: ['connect', [body?.serverId]], disconnect: ['disconnect', []],
      'delete-subscription': ['delete-subscription', [body?.subId]],
      'refresh-subscription': ['refresh-subscription', [body?.subId]],
      'delete-server': ['delete-server', [body?.serverId]],
      'select-server': ['select-server', [body?.serverId]],
      settings: ['update-settings', [body]], 'terminal-env': ['toggle-terminal-env', [body?.enabled]],
      'routing-mode': ['set-routing-mode', [body?.mode]],
    };
    const [event, args] = mappings[name];
    return ipc.get('vpn:' + event)!(null, ...args);
  };
  if (kind === 'standalone') await api('/api/init');
  return {
    controls, api, call, files, signals,
    state: () => call('init'),
    async tick() { const fn = [...intervals.values()].at(-1); assert.ok(fn); await fn(); },
  };
}
