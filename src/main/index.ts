import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMultipleLinks } from './parser.ts';
import { fetchSubscription } from './subscription.ts';
import { replaceSubscriptionNodes } from './subscriptionState.ts';
import { generateXrayConfig, wantsInsecureTls } from './xrayConfig.ts';
import { fetchLeafCertSha256 } from './certPin.ts';
import { XrayRunner, testProxyConnectivity } from './xrayRunner.ts';
import { clearServerPing, measureServerPings } from './serverPing.ts';
import { ConnectionQueue, waitForConnectionTask } from './connectionQueue.ts';
import { getNetworkSettings, validateNetworkSettings } from './networkSettings.ts';
import {
  enableWindowsSystemProxy,
  disableWindowsSystemProxy,
  setWindowsTerminalProxyEnv,
  getTerminalProxyCommands,
} from './systemProxy.ts';
import { TunManager, checkIsAdmin, detectPhysicalGateway, resolveServerAddresses, type PhysicalRouteInfo } from './tunManager.ts';
import type {
  LogEntry,
  PersistedData,
  RoutingMode,
  VpnStatus,
  ServerNode,
  SubscriptionItem,
} from './types.ts';

const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let xrayRunner: XrayRunner;
let tunManager: TunManager;
let statsTimer: NodeJS.Timeout | null = null;
let lastPolledUp = 0;
let lastPolledDown = 0;
let statsGeneration = 0;
const connectionQueue = new ConnectionQueue();

const logs: LogEntry[] = [];

function resolveBinDir(): string {
  const candidates = [
    path.resolve(app.getAppPath(), 'resources', 'bin'),
    path.resolve(process.cwd(), 'resources', 'bin'),
    path.resolve(__dirname, '..', 'resources', 'bin'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

function getStateFilePath(): string {
  return path.join(app.getPath('userData'), 'vpn-state.json');
}

const defaultPersistedData: PersistedData = {
  servers: [],
  subscriptions: [],
  activeServerId: null,
  routingMode: 'system_proxy',
  socksPort: 10808,
  httpPort: 10809,
  bypassLan: true,
  allowInsecureDefault: false,
  totalUp: 0,
  totalDown: 0,
};

let persistedData: PersistedData = { ...defaultPersistedData };

let vpnStatus: VpnStatus = {
  connected: false,
  connecting: false,
  activeServerId: null,
  routingMode: 'system_proxy',
  isAdmin: false,
  tunActive: false,
  systemProxyActive: false,
  terminalEnvActive: false,
  connectedAt: null,
  lastError: null,
  socksPort: 10808,
  httpPort: 10809,
  binariesReady: {
    xray: false,
    tun2socks: false,
    wintun: false,
  },
  stats: {
    upSpeed: 0,
    downSpeed: 0,
    sessionUp: 0,
    sessionDown: 0,
    totalUp: 0,
    totalDown: 0,
  },
};

function loadPersistedData(): void {
  try {
    const file = getStateFilePath();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PersistedData>;
      persistedData = {
        ...defaultPersistedData,
        ...raw,
        servers: Array.isArray(raw.servers) ? raw.servers : [],
        subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
      };
    }
  } catch {
    persistedData = { ...defaultPersistedData };
  }
  for (const node of persistedData.servers) clearServerPing(node);
  vpnStatus.activeServerId = persistedData.activeServerId;
  vpnStatus.routingMode = persistedData.routingMode;
  vpnStatus.socksPort = persistedData.socksPort;
  vpnStatus.httpPort = persistedData.httpPort;
  vpnStatus.stats.totalUp = persistedData.totalUp || 0;
  vpnStatus.stats.totalDown = persistedData.totalDown || 0;
}

function savePersistedData(): void {
  try {
    const file = getStateFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(persistedData, null, 2), 'utf-8');
  } catch {
    // ignore write error
  }
}

function checkBinaries() {
  const binDir = resolveBinDir();
  vpnStatus.binariesReady = {
    xray: fs.existsSync(path.join(binDir, 'xray.exe')),
    tun2socks: fs.existsSync(path.join(binDir, 'tun2socks.exe')),
    wintun: fs.existsSync(path.join(binDir, 'wintun.dll')),
  };
}

function addLog(source: 'xray' | 'tun' | 'system', level: 'info' | 'warn' | 'error', message: string) {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source,
    level,
    message,
  };
  logs.push(entry);
  if (logs.length > 400) {
    logs.shift();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn:log', entry);
  }
}

function broadcastStatus() {
  checkBinaries();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn:status', vpnStatus);
  }
}

function broadcastData() {
  savePersistedData();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn:data', persistedData);
  }
}

function startStatsPolling() {
  stopStatsPolling();
  lastPolledUp = 0;
  lastPolledDown = 0;
  const generation = statsGeneration;
  let polling = false;

  statsTimer = setInterval(async () => {
    if (polling || !vpnStatus.connected || !xrayRunner.isRunning()) return;
    polling = true;
    try {
      const res = await xrayRunner.queryTrafficStats();
      if (generation !== statsGeneration || !vpnStatus.connected) return;
      if (!res) return;

      const { upBytes, downBytes } = res;
      const upSpeed = Math.max(0, upBytes - lastPolledUp);
      const downSpeed = Math.max(0, downBytes - lastPolledDown);

      lastPolledUp = upBytes;
      lastPolledDown = downBytes;

      vpnStatus.stats = {
        upSpeed,
        downSpeed,
        sessionUp: upBytes,
        sessionDown: downBytes,
        totalUp: (persistedData.totalUp || 0) + upSpeed,
        totalDown: (persistedData.totalDown || 0) + downSpeed,
      };

      persistedData.totalUp = vpnStatus.stats.totalUp;
      persistedData.totalDown = vpnStatus.stats.totalDown;
      broadcastStatus();
    } finally {
      polling = false;
    }
  }, 1000);
}

function stopStatsPolling() {
  statsGeneration++;
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  vpnStatus.stats.upSpeed = 0;
  vpnStatus.stats.downSpeed = 0;
}

async function disconnectVpn(): Promise<void> {
  return connectionQueue.replace(() => disconnectVpnNow());
}

async function handleUnexpectedExit(component: string, code: number | null): Promise<void> {
  if (!vpnStatus.connected) return;
  const message = `${component} process exited unexpectedly (code ${code ?? 'unknown'})`;
  vpnStatus.connected = false;
  vpnStatus.connectedAt = null;
  vpnStatus.lastError = message;
  stopStatsPolling();
  broadcastStatus();
  await connectionQueue.replace(async () => {
    let detail = message;
    try { await disconnectVpnNow(); }
    catch (error) { detail += `; ${String(error)}`; }
    vpnStatus.lastError = detail;
    addLog('system', 'error', detail);
    broadcastStatus();
  });
}

async function stopVpnResources(): Promise<void> {
  stopStatsPolling();
  const results = await Promise.allSettled([
    tunManager?.stop(),
    disableWindowsSystemProxy(),
    setWindowsTerminalProxyEnv(false, persistedData.httpPort, persistedData.socksPort),
    xrayRunner?.stop(),
  ]);
  if (results[0].status === 'fulfilled') vpnStatus.tunActive = false;
  if (results[1].status === 'fulfilled') vpnStatus.systemProxyActive = false;
  if (results[2].status === 'fulfilled') vpnStatus.terminalEnvActive = false;
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length) throw new Error(`Network cleanup failed: ${errors.map(result => String(result.reason)).join('; ')}`);
}

async function disconnectVpnNow(): Promise<void> {
  try {
    await stopVpnResources();
  } catch (error) {
    vpnStatus.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    vpnStatus.connected = false;
    vpnStatus.connecting = false;
    vpnStatus.connectedAt = null;
    savePersistedData();
    broadcastStatus();
  }
  addLog('system', 'info', 'Disconnected VPN and restored OS network settings.');
}

async function connectVpn(targetServerId?: string): Promise<{ ok: boolean; error?: string }> {
  if (quitting) return { ok: false, error: 'Controller is shutting down' };
  return connectionQueue.replace((signal) => connectVpnNow(targetServerId, signal));
}

async function connectVpnNow(targetServerId: string | undefined, signal: AbortSignal, restoreTerminal = vpnStatus.terminalEnvActive): Promise<{ ok: boolean; error?: string }> {
  if (quitting) return { ok: false, error: 'Controller is shutting down' };
  if (signal.aborted) return { ok: false, error: 'Connection cancelled' };
  const serverId = targetServerId || persistedData.activeServerId || persistedData.servers[0]?.id;
  if (!serverId) {
    const err = 'No server selected. Import a vless:// or vmess:// link first.';
    vpnStatus.lastError = err;
    broadcastStatus();
    return { ok: false, error: err };
  }

  const node = persistedData.servers.find((s) => s.id === serverId);
  if (!node) {
    const err = 'Selected server node not found.';
    vpnStatus.lastError = err;
    broadcastStatus();
    return { ok: false, error: err };
  }

  stopStatsPolling();
  vpnStatus.connected = false;
  persistedData.activeServerId = node.id;
  vpnStatus.activeServerId = node.id;
  vpnStatus.connecting = true;
  vpnStatus.lastError = null;
  broadcastData();
  broadcastStatus();

  try {
    validateNetworkSettings(persistedData, {});
    await stopVpnResources();
    signal.throwIfAborted();

    let serverIps: string[] = [];
    let physicalRoute: PhysicalRouteInfo | undefined;
    if (persistedData.routingMode === 'tun') {
      serverIps = await waitForConnectionTask(resolveServerAddresses(node.address), signal);
      if (!serverIps.length) throw new Error('Could not resolve the VPN server for TUN routing');
      physicalRoute = await waitForConnectionTask(detectPhysicalGateway(serverIps[0].includes(':') ? 6 : 4), signal);
    }

    const configOptions = {
      socksPort: persistedData.socksPort,
      httpPort: persistedData.httpPort,
      bypassLan: persistedData.bypassLan,
      allowInsecureDefault: persistedData.allowInsecureDefault,
      resolvedServerAddress: serverIps[0],
      tunMode: persistedData.routingMode === 'tun',
      physicalInterfaceName: physicalRoute?.interfaceName,
    };
    let pinnedCertSha256: string | undefined;
    if (wantsInsecureTls(node, configOptions)) {
      pinnedCertSha256 = await waitForConnectionTask(fetchLeafCertSha256(serverIps[0] || node.address, node.port, node.sni || node.host || node.address), signal);
      addLog('system', 'info', `Allow insecure: pinned server certificate SHA-256 ${pinnedCertSha256.slice(0, 16)}…`);
    }
    await xrayRunner.start(node, { ...configOptions, pinnedCertSha256 });
    signal.throwIfAborted();

    if (persistedData.routingMode === 'tun') {
      await tunManager.start(resolveBinDir(), persistedData.socksPort, node.address, serverIps, physicalRoute, signal);
      signal.throwIfAborted();
      vpnStatus.tunActive = true;
      vpnStatus.systemProxyActive = false;
    } else {
      await enableWindowsSystemProxy(persistedData.httpPort);
      vpnStatus.systemProxyActive = true;
      vpnStatus.tunActive = false;
      addLog(
        'system',
        'info',
        `Windows System Proxy enabled -> 127.0.0.1:${persistedData.httpPort} (SOCKS5 -> 127.0.0.1:${persistedData.socksPort})`
      );
    }

    signal.throwIfAborted();
    if (restoreTerminal) {
      await setWindowsTerminalProxyEnv(true, persistedData.httpPort, persistedData.socksPort);
      vpnStatus.terminalEnvActive = true;
      signal.throwIfAborted();
    }
    if (!xrayRunner.isRunning()) throw new Error('Xray stopped while connecting');
    if (persistedData.routingMode === 'tun' && !tunManager.isRunning()) throw new Error('TUN stopped while connecting');
    vpnStatus.connected = true;
    vpnStatus.connecting = false;
    vpnStatus.connectedAt = Date.now();
    vpnStatus.stats.sessionUp = 0;
    vpnStatus.stats.sessionDown = 0;
    startStatsPolling();
    broadcastStatus();
    void measureServerPings([node], broadcastData);
    return { ok: true };
  } catch (err) {
    let msg = err instanceof Error ? err.message : String(err);
    addLog('system', signal.aborted ? 'info' : 'error', signal.aborted ? 'Connection cancelled.' : `Connection failed: ${msg}`);
    try { await stopVpnResources(); }
    catch (cleanupError) { msg += `; ${String(cleanupError)}`; }

    vpnStatus.connected = false;
    vpnStatus.connecting = false;
    vpnStatus.connectedAt = null;
    vpnStatus.lastError = signal.aborted ? null : msg;
    broadcastStatus();
    return { ok: false, error: msg };
  }
}

async function updateSubscriptionNodes(subId: string, subscription: SubscriptionItem | null, nodes: ServerNode[] = []) {
  const affectsActive = () => persistedData.servers.some((node) => node.id === vpnStatus.activeServerId && node.subscriptionId === subId);
  const wasLive = affectsActive() && (vpnStatus.connected || vpnStatus.connecting);
  const update = async (signal: AbortSignal) => {
    const activeId = vpnStatus.activeServerId;
    const restoreTerminal = vpnStatus.terminalEnvActive;
    const reconnect = wasLive || (affectsActive() && (vpnStatus.connected || vpnStatus.connecting));
    if (reconnect) await disconnectVpnNow();
    replaceSubscriptionNodes(persistedData, subId, subscription, nodes);
    vpnStatus.activeServerId = persistedData.activeServerId;
    broadcastData();
    broadcastStatus();
    if (subscription && reconnect && nodes.some((node) => node.id === activeId) && !signal.aborted) {
      return connectVpnNow(activeId!, signal, restoreTerminal);
    }
    return { ok: true };
  };
  return wasLive ? connectionQueue.replace(update) : connectionQueue.enqueue(update);
}

function registerIpcHandlers() {
  ipcMain.handle('vpn:get-initial-data', async () => {
    vpnStatus.isAdmin = await checkIsAdmin();
    checkBinaries();
    return {
      status: vpnStatus,
      data: persistedData,
      logs,
      terminalCommands: getTerminalProxyCommands(
        persistedData.httpPort,
        persistedData.socksPort
      ),
    };
  });

  ipcMain.handle('vpn:connect', async (_e, serverId?: string) => {
    return await connectVpn(serverId);
  });

  ipcMain.handle('vpn:disconnect', async () => {
    await disconnectVpn();
    return { ok: true };
  });

  ipcMain.handle('vpn:set-routing-mode', async (_e, mode: RoutingMode) => {
    if (mode !== 'tun' && mode !== 'system_proxy') return { ok: false, error: 'Invalid routing mode' };
    if (mode === persistedData.routingMode) return { ok: true };
    const wasLive = vpnStatus.connected || vpnStatus.connecting;
    return connectionQueue.replace(async (signal) => {
      if (signal.aborted || quitting) return { ok: false, error: 'Settings update cancelled' };
      const previous = persistedData.routingMode;
      persistedData.routingMode = mode;
      vpnStatus.routingMode = mode;
      const result = wasLive || vpnStatus.connected || vpnStatus.connecting
        ? await connectVpnNow(persistedData.activeServerId || undefined, signal)
        : { ok: true };
      if (!result.ok) persistedData.routingMode = previous;
      vpnStatus.routingMode = persistedData.routingMode;
      broadcastData();
      broadcastStatus();
      return result;
    });
  });

  ipcMain.handle('vpn:toggle-terminal-env', async (_e, enabled: boolean) => {
    try {
      await connectionQueue.enqueue(async () => {
        if (enabled && (!vpnStatus.connected || vpnStatus.connecting)) throw new Error('Connect the VPN before enabling terminal proxy variables.');
        await setWindowsTerminalProxyEnv(enabled, persistedData.httpPort, persistedData.socksPort);
        vpnStatus.terminalEnvActive = enabled;
      });
      addLog(
        'system',
        'info',
        enabled
          ? `Set Windows User Environment Variables (HTTP_PROXY=http://127.0.0.1:${persistedData.httpPort}, ALL_PROXY=socks5://127.0.0.1:${persistedData.socksPort}). New terminal windows will now route commands through Xray.`
          : 'Restored the original Windows terminal proxy environment variables.'
      );
      broadcastStatus();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('vpn:relaunch-admin', async () => {
    try {
      await disconnectVpn();
      const exePath = process.execPath;
      const appPath = app.getAppPath();
      const psCmd = `Start-Process -FilePath '${exePath}' -ArgumentList '${appPath}' -Verb RunAs`;
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psCmd,
      ]);
      app.quit();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('system', 'warn', `Administrator elevation cancelled or failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('vpn:import-links', (_e, rawText: string) => {
    const { nodes, errors } = parseMultipleLinks(rawText);
    if (nodes.length > 0) {
      persistedData.servers.push(...nodes);
      if (!persistedData.activeServerId) {
        persistedData.activeServerId = nodes[0].id;
        vpnStatus.activeServerId = nodes[0].id;
      }
      addLog('system', 'info', `Imported ${nodes.length} server node(s).`);
      broadcastData();
      broadcastStatus();
    }
    return {
      importedCount: nodes.length,
      errors,
    };
  });

  ipcMain.handle('vpn:select-server', async (_e, serverId: string) => {
    if (!persistedData.servers.some((node) => node.id === serverId)) return { ok: false, error: 'Server not found' };
    if (vpnStatus.connected || vpnStatus.connecting) return connectVpn(serverId);
    persistedData.activeServerId = serverId;
    vpnStatus.activeServerId = serverId;
    broadcastData();
    broadcastStatus();
    if (vpnStatus.connected) {
      return await connectVpn(serverId);
    }
    return { ok: true };
  });

  ipcMain.handle('vpn:delete-server', async (_e, serverId: string) => {
    if ((vpnStatus.connected || vpnStatus.connecting) && vpnStatus.activeServerId === serverId) {
      await disconnectVpn();
    }
    persistedData.servers = persistedData.servers.filter((s) => s.id !== serverId);
    if (persistedData.activeServerId === serverId) {
      persistedData.activeServerId = persistedData.servers[0]?.id || null;
      vpnStatus.activeServerId = persistedData.activeServerId;
    }
    broadcastData();
    broadcastStatus();
    return { ok: true };
  });

  ipcMain.handle('vpn:ping-server', async (_e, serverId: string) => {
    const node = persistedData.servers.find((s) => s.id === serverId);
    if (!node) return { ok: false, error: 'Server not found' };
    await measureServerPings([node], broadcastData);
    return { ping: node.ping, pingStatus: node.pingStatus, pingError: node.pingError, pingCheckedAt: node.pingCheckedAt };
  });

  ipcMain.handle('vpn:ping-all-servers', async () => {
    await measureServerPings(persistedData.servers, broadcastData);
    return { ok: true };
  });

  ipcMain.handle('vpn:test-active-tunnel', async () => {
    if (!vpnStatus.connected) {
      return { ok: false, latencyMs: -1, error: 'VPN is not connected' };
    }
    const res = await testProxyConnectivity(persistedData.httpPort);
    if (res.ok) {
      addLog(
        'system',
        'info',
        `End-to-end tunnel verification succeeded! Real HTTP 204 round-trip latency: ${res.latencyMs} ms`
      );
    } else {
      addLog('system', 'warn', `End-to-end tunnel test failed: ${res.error}`);
    }
    return res;
  });

  ipcMain.handle('vpn:add-subscription', async (_e, url: string, name?: string) => {
    try {
      addLog('system', 'info', `Fetching subscription from ${url} ...`);
      const { subscription, nodes } = await fetchSubscription(url, undefined, name);
      persistedData.subscriptions.push(subscription);
      persistedData.servers.push(...nodes);
      if (!persistedData.activeServerId && nodes.length > 0) {
        persistedData.activeServerId = nodes[0].id;
        vpnStatus.activeServerId = nodes[0].id;
      }
      addLog(
        'system',
        'info',
        `Subscription "${subscription.name}" added with ${nodes.length} server nodes.`
      );
      broadcastData();
      broadcastStatus();
      return { ok: true, count: nodes.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('system', 'error', `Failed to fetch subscription: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('vpn:refresh-subscription', async (_e, subId: string) => {
    const existing = persistedData.subscriptions.find((s) => s.id === subId);
    if (!existing) return { ok: false, error: 'Subscription not found' };

    try {
      addLog('system', 'info', `Refreshing subscription "${existing.name}" ...`);
      const { subscription, nodes } = await fetchSubscription(
        existing.url,
        existing.id,
        existing.name
      );
      const result = await updateSubscriptionNodes(subId, subscription, nodes);
      addLog(
        'system',
        'info',
        `Subscription "${subscription.name}" updated (${nodes.length} nodes).`
      );
      broadcastData();
      broadcastStatus();
      return { ...result, count: nodes.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('system', 'error', `Subscription refresh failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('vpn:delete-subscription', async (_e, subId: string) => {
    return updateSubscriptionNodes(subId, null);
  });

  ipcMain.handle('vpn:get-server-config', (_e, serverId: string) => {
    const node = persistedData.servers.find((s) => s.id === serverId);
    if (!node) return '';
    const cfg = generateXrayConfig(node, {
      socksPort: persistedData.socksPort,
      httpPort: persistedData.httpPort,
      bypassLan: persistedData.bypassLan,
      allowInsecureDefault: persistedData.allowInsecureDefault,
    });
    return JSON.stringify(cfg, null, 2);
  });

  ipcMain.handle(
    'vpn:update-settings',
    async (
      _e,
      settings: {
        socksPort?: number;
        httpPort?: number;
        bypassLan?: boolean;
        allowInsecureDefault?: boolean;
      }
    ) => {
      let next;
      try { next = validateNetworkSettings(persistedData, settings); }
      catch (error) { return { ok: false, error: String(error instanceof Error ? error.message : error) }; }
      const networkChanged = Object.entries(next).some(([key, value]) => value !== getNetworkSettings(persistedData)[key as keyof typeof next]);
      let result: { ok: boolean; error?: string } = { ok: true };
      if (networkChanged) {
        const wasLive = vpnStatus.connected || vpnStatus.connecting;
        result = await connectionQueue.replace(async (signal) => {
          const previous = getNetworkSettings(persistedData);
          const updated = validateNetworkSettings(persistedData, settings);
          if (signal.aborted) return { ok: false, error: 'Settings update cancelled' };
          Object.assign(persistedData, updated);
          vpnStatus.socksPort = updated.socksPort;
          vpnStatus.httpPort = updated.httpPort;
          const connected = wasLive || vpnStatus.connected || vpnStatus.connecting;
          const applied = connected ? await connectVpnNow(persistedData.activeServerId || undefined, signal) : { ok: true };
          if (!applied.ok) {
            Object.assign(persistedData, previous);
            vpnStatus.socksPort = previous.socksPort;
            vpnStatus.httpPort = previous.httpPort;
          }
          return applied;
        });
      }
      broadcastData();
      broadcastStatus();
      return {
        ...result,
        terminalCommands: getTerminalProxyCommands(
          persistedData.httpPort,
          persistedData.socksPort
        ),
      };
    }
  );

  ipcMain.handle('vpn:clear-logs', () => {
    logs.length = 0;
    return { ok: true };
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Xray VPN',
    backgroundColor: '#F6F8FA',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.maximize();
  mainWindow.show();

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    const indexHtml = path.resolve(__dirname, '..', 'dist', 'index.html');
    await mainWindow.loadFile(indexHtml);
  }
}

app.whenReady().then(async () => {
  loadPersistedData();
  vpnStatus.isAdmin = await checkIsAdmin();
  checkBinaries();

  xrayRunner = new XrayRunner(
    resolveBinDir(),
    app.getPath('userData'),
    (level, msg) => addLog('xray', level, msg),
    (code) => handleUnexpectedExit('Xray', code)
  );

  tunManager = new TunManager(
    (level, msg) => addLog('tun', level, msg),
    (code) => handleUnexpectedExit('TUN', code)
  );

  registerIpcHandlers();
  await createWindow();
  void measureServerPings(persistedData.servers, broadcastData);

  addLog(
    'system',
    'info',
    `Xray VPN Client initialized. Administrator Mode: ${vpnStatus.isAdmin ? 'YES (TUN Ready)' : 'NO (System Proxy / Terminal Env Ready)'}`
  );
});

let quitReady = false;
let quitting = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void disconnectVpn().then(() => {
    quitReady = true;
    app.quit();
  }).catch((error) => {
    quitting = false;
    addLog('system', 'error', `Shutdown cleanup failed: ${String(error)}`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
