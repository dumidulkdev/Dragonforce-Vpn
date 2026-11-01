import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseMultipleLinks } from './parser.ts';
import { fetchSubscription } from './subscription.ts';
import { replaceSubscriptionNodes } from './subscriptionState.ts';
import { generateXrayConfig, wantsInsecureTls } from './xrayConfig.ts';
import { fetchLeafCertSha256 } from './certPin.ts';
import { XrayRunner, testProxyConnectivity } from './xrayRunner.ts';
import { clearServerPing, measureServerPings } from './serverPing.ts';
import {
  enableSystemProxy,
  disableSystemProxy,
  enableTerminalProxy,
  disableTerminalProxy,
  getTerminalProxyCommands,
  type ProxyOperationResult,
} from './systemProxy.ts';
import {
  TunManager,
  checkIsAdmin,
  detectPhysicalGateway,
  resolveServerIpv4List,
  resolveServerAddresses,
  type PhysicalRouteInfo,
} from './tunManager.ts';
import { lookupGeo, lookupExitGeo } from './geo.ts';
import { applyServerEdit, toShareLink, type ServerEdit } from './serverEdit.ts';
import { SpeedTest } from './speedTest.ts';
import { ConnectionQueue, waitForConnectionTask } from './connectionQueue.ts';
import { validateLocalRequest } from './localApi.ts';
import { serveAsset } from './httpAssets.ts';
import { stopPreviousController } from './controllerInstance.ts';
import { getNetworkSettings, validateNetworkSettings } from './networkSettings.ts';
import { verifyAdBlock } from './adblockVerification.ts';
import {
  defaultDataCap,
  ensureUsageHistory,
  recordSessionStart,
  recordTrafficTick,
} from './usageTracker.ts';
import { captureWindowsScreen, readWindowsClipboard } from './qrSystemBridge.ts';
import {
  AdBlockLogWatcher,
  ensureAdBlockState,
  evaluateDomainShield,
} from './adblockEngine.ts';
import {
  PRESET_IDS,
  ensureSplitTunnelConfig,
  evaluateSplitTunnelRoute,
  parseSplitTargetInput,
  sanitizeDomainEntry,
} from './splitTunnelEngine.ts';
import { resolveNativeBinaries } from './binaries.ts';
import type {
  LogEntry,
  PersistedData,
  RoutingMode,
  SpeedTestResult,
  SplitTunnelPresetId,
  VpnStatus,
  ServerNode,
  SubscriptionItem,
} from './types.ts';

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = process.env.VPN_APP_ROOT || path.resolve(moduleDir, path.basename(moduleDir) === 'dist-electron' ? '..' : '../..');
const binDir = process.env.VPN_BIN_DIR || path.join(rootDir, 'resources', 'bin');
const dataDir = process.env.VPN_DATA_DIR
  ? path.resolve(process.env.VPN_DATA_DIR)
  : path.join(rootDir, 'data');
const stateFilePath = path.join(dataDir, 'vpn-state.json');
const accessLogPath = path.join(dataDir, 'xray-access.log');
const adblockWatcher = new AdBlockLogWatcher();
const publicDir = path.join(rootDir, 'public');
const uiHtmlPath = path.join(publicDir, 'app.html');
const assetsDir = path.join(publicDir, 'assets');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const PORT = Number(process.env.VPN_UI_PORT || 17890);
const apiToken = crypto.randomBytes(32).toString('hex');
let shuttingDown = false;

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
  muxEnabled: false,
  theme: 'light',
};

let persistedData: PersistedData = { ...defaultPersistedData };
let lastPolledUp = 0;
let lastPolledDown = 0;
let statsTimer: NodeJS.Timeout | null = null;
let statsGeneration = 0;
const connectionQueue = new ConnectionQueue();

const logs: LogEntry[] = [];
const sseClients = new Set<http.ServerResponse>();

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

function checkBinaries() {
  const binaries = resolveNativeBinaries({ bundledBinDir: binDir });
  vpnStatus.binariesReady = {
    xray: Boolean(binaries.xrayPath),
    tun2socks: Boolean(binaries.tun2socksPath),
    // The existing boolean means the platform's driver requirement is satisfied.
    wintun: process.platform !== 'win32' || Boolean(binaries.wintunPath),
  };
}

function loadPersistedData() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const raw = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8')) as Partial<PersistedData>;
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
  ensureUsageHistory(persistedData);
  persistedData.adblock = ensureAdBlockState(persistedData.adblock);
  persistedData.splitTunnel = ensureSplitTunnelConfig(persistedData.splitTunnel);
  savePersistedData();
  vpnStatus.activeServerId = persistedData.activeServerId;
  vpnStatus.routingMode = persistedData.routingMode;
  vpnStatus.socksPort = persistedData.socksPort;
  vpnStatus.httpPort = persistedData.httpPort;
  vpnStatus.stats.totalUp = persistedData.totalUp || 0;
  vpnStatus.stats.totalDown = persistedData.totalDown || 0;
}

function savePersistedData() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(persistedData, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

function sendSse(event: string, payload: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
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
  if (logs.length > 400) logs.shift();
  sendSse('log', entry);
}

function broadcastStatus() {
  checkBinaries();
  sendSse('status', vpnStatus);
}

function broadcastData() {
  savePersistedData();
  sendSse('data', persistedData);
}

// ---------------------------------------------------------------------------
// Geo-location (map visualisation only — never on the VPN data path)
// ---------------------------------------------------------------------------

let geoResolving = false;

/** Resolves country/city/coordinates for every server that doesn't have them yet. */
async function ensureServerGeo(): Promise<void> {
  if (geoResolving) return;
  geoResolving = true;
  try {
    persistedData.geoCache = persistedData.geoCache || {};
    let changed = false;
    for (const node of persistedData.servers) {
      if (node.geo) continue;
      const [ip] = await resolveServerIpv4List(node.address);
      if (!ip) continue;
      let geo = persistedData.geoCache[ip];
      if (!geo) {
        const found = await lookupGeo(ip);
        if (!found) continue;
        geo = found;
        persistedData.geoCache[ip] = geo;
      }
      node.geo = geo;
      changed = true;
    }
    if (changed) broadcastData();
  } finally {
    geoResolving = false;
  }
}

/** The user's own location. Only looked up while disconnected so it isn't the exit IP. */
async function refreshOriginGeo(): Promise<void> {
  if (vpnStatus.connected || vpnStatus.connecting) return;
  const geo = await lookupGeo();
  if (geo && !vpnStatus.connected && !vpnStatus.connecting) {
    persistedData.originGeo = geo;
    broadcastData();
  }
}

async function refreshExitGeo(): Promise<void> {
  const geo = await lookupExitGeo(persistedData.httpPort);
  if (vpnStatus.connected) {
    vpnStatus.exitGeo = geo;
    broadcastStatus();
  }
}

// ---------------------------------------------------------------------------
// Speed test
// ---------------------------------------------------------------------------

let activeSpeedTest: SpeedTest | null = null;

/**
 * Runs a speed test through the active route: the TUN adapter (real app path),
 * the local Xray proxy in system-proxy mode, or the direct line when disconnected.
 */
async function runSpeedTest(): Promise<void> {
  const viaVpn = vpnStatus.connected;
  const node = persistedData.servers.find((s) => s.id === vpnStatus.activeServerId);
  const base = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    route: viaVpn ? ('vpn' as const) : ('direct' as const),
    serverName: viaVpn ? node?.name ?? null : null,
  };
  const test = new SpeedTest(viaVpn ? persistedData.httpPort : null, (p) =>
    sendSse('speedtest', { running: true, route: base.route, serverName: base.serverName, ...p })
  );
  activeSpeedTest = test;
  addLog('system', 'info', `Speed test started (${viaVpn ? `via ${base.serverName}` : 'direct, VPN off'}).`);
  try {
    const measured = await test.run();
    const result: SpeedTestResult = { ...base, ...measured };
    persistedData.speedTests = [result, ...(persistedData.speedTests || [])].slice(0, 10);
    broadcastData();
    sendSse('speedtest', { running: false, done: true, result });
    addLog('system', 'info', `Speed test: ↓ ${result.downloadMbps} Mbps, ↑ ${result.uploadMbps} Mbps, ping ${result.pingMs} ms.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendSse('speedtest', { running: false, done: true, error: msg });
    addLog('system', 'warn', `Speed test failed: ${msg}`);
  } finally {
    activeSpeedTest = null;
  }
}

const xrayRunner = new XrayRunner(
  binDir,
  dataDir,
  (level, msg) => addLog('xray', level, msg),
  (code) => handleUnexpectedExit('Xray', code)
);

const tunManager = new TunManager(
  (level, msg) => addLog('tun', level, msg),
  (code) => handleUnexpectedExit('TUN', code)
);

async function handleUnexpectedExit(component: string, code: number | null): Promise<void> {
  // Startup failures are returned by start(); successful connections need the
  // same serialized restoration path as a user-initiated disconnect.
  if (!vpnStatus.connected) return;
  const message = `${component} process exited unexpectedly (code ${code ?? 'unknown'})`;
  vpnStatus.connected = false;
  vpnStatus.connectedAt = null;
  vpnStatus.exitGeo = null;
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

function startStatsPolling(resetCounters = true) {
  stopStatsPolling();
  if (resetCounters) {
    lastPolledUp = 0;
    lastPolledDown = 0;
  }
  const generation = statsGeneration;
  let polling = false;
  let tickCount = 0;

  statsTimer = setInterval(async () => {
    if (polling || !vpnStatus.connected || !xrayRunner.isRunning()) return;
    polling = true;
    try {
      persistedData.adblock = ensureAdBlockState(persistedData.adblock);
      const newlyBlocked = adblockWatcher.poll(accessLogPath, persistedData.adblock);
      const res = await xrayRunner.queryTrafficStats();
      if (generation !== statsGeneration || !vpnStatus.connected) return;
      if (!res) {
        if (newlyBlocked > 0) broadcastData();
        return;
      }

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

      const activeNode = persistedData.servers.find((s) => s.id === vpnStatus.activeServerId);
      const capEval = recordTrafficTick(persistedData, activeNode, upSpeed, downSpeed, 1);

      tickCount++;
      if (tickCount % 5 === 0 || newlyBlocked > 0 || capEval.warnTriggered || capEval.limitReached) {
        broadcastData();
      }

      if (capEval.limitReached) {
        addLog(
          'system',
          'warn',
          `Data cap reached (100% of ${capEval.periodLabel} limit).${persistedData.usageHistory?.dataCap.autoDisconnect ? ' Auto-disconnecting VPN.' : ''}`
        );
        sendSse('datacap', {
          level: 'limit',
          usedBytes: capEval.usedBytes,
          limitBytes: capEval.limitBytes,
          pct: Math.round(capEval.pct),
          periodLabel: capEval.periodLabel,
          autoDisconnect: Boolean(persistedData.usageHistory?.dataCap.autoDisconnect),
        });
        if (persistedData.usageHistory?.dataCap.autoDisconnect) {
          await disconnectVpn();
          return;
        }
      } else if (capEval.warnTriggered) {
        addLog(
          'system',
          'warn',
          `Data usage alert: ${Math.round(capEval.pct)}% of ${capEval.periodLabel} data cap used.`
        );
        sendSse('datacap', {
          level: 'warn',
          usedBytes: capEval.usedBytes,
          limitBytes: capEval.limitBytes,
          pct: Math.round(capEval.pct),
          periodLabel: capEval.periodLabel,
          autoDisconnect: false,
        });
      }

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

async function stopVpnResources(): Promise<void> {
  activeSpeedTest?.abort();
  stopStatsPolling();
  const results = await Promise.allSettled([
    tunManager.stop(),
    disableSystemProxy(),
    disableTerminalProxy(persistedData.httpPort, persistedData.socksPort),
    xrayRunner.stop(),
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
    vpnStatus.exitGeo = null;
    savePersistedData();
    broadcastStatus();
  }
  addLog(
    'system',
    'info',
    process.platform === 'linux'
      ? 'Stopped Xray and the local proxy listeners. No Linux desktop-wide proxy settings were changed.'
      : 'Disconnected VPN and restored OS network settings.'
  );
  void refreshOriginGeo();
}

async function connectVpn(targetServerId?: string): Promise<{ ok: boolean; error?: string }> {
  if (shuttingDown) return { ok: false, error: 'Controller is shutting down' };
  return connectionQueue.replace((signal) => connectVpnNow(targetServerId, signal));
}

async function connectVpnNow(targetServerId: string | undefined, signal: AbortSignal, restoreTerminal = vpnStatus.terminalEnvActive): Promise<{ ok: boolean; error?: string }> {
  if (shuttingDown) return { ok: false, error: 'Controller is shutting down' };
  if (signal.aborted) return { ok: false, error: 'Connection cancelled' };
  const serverId = targetServerId || persistedData.activeServerId || persistedData.servers[0]?.id;
  if (!serverId) {
    const err = 'No server selected. Paste a vless:// or vmess:// link first.';
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
  vpnStatus.exitGeo = null;
  broadcastData();
  broadcastStatus();

  try {
    validateNetworkSettings(persistedData, {}, PORT);
    await stopVpnResources();
    signal.throwIfAborted();
    if (persistedData.routingMode === 'tun' && process.platform !== 'win32') {
      throw new Error('Full TUN mode is not available on Linux yet. Use Local Proxy mode.');
    }

    let serverIps: string[] = [];
    let physicalRoute: PhysicalRouteInfo | undefined;
    if (persistedData.routingMode === 'tun') {
      serverIps = await waitForConnectionTask(resolveServerAddresses(node.address), signal);
      if (!serverIps.length) throw new Error('Could not resolve the VPN server for TUN routing');
      if (serverIps.length > 0) {
        addLog('system', 'info', `Resolved ${node.address} -> ${serverIps.join(', ')}`);
      }
      physicalRoute = await waitForConnectionTask(detectPhysicalGateway(serverIps[0].includes(':') ? 6 : 4), signal);
    }
    signal.throwIfAborted();

    persistedData.adblock = ensureAdBlockState(persistedData.adblock);
    persistedData.splitTunnel = ensureSplitTunnelConfig(persistedData.splitTunnel);
    try {
      if (fs.existsSync(accessLogPath)) fs.truncateSync(accessLogPath, 0);
    } catch {
      // ignore
    }
    adblockWatcher.reset();

    const configOptions = {
      socksPort: persistedData.socksPort,
      httpPort: persistedData.httpPort,
      bypassLan: persistedData.bypassLan,
      allowInsecureDefault: persistedData.allowInsecureDefault,
      resolvedServerAddress: serverIps[0],
      tunMode: persistedData.routingMode === 'tun',
      mux: Boolean(persistedData.muxEnabled),
      adblock: persistedData.adblock.config,
      splitTunnel: persistedData.splitTunnel,
      accessLogPath,
      physicalInterfaceName: physicalRoute?.interfaceName,
    };
    let pinnedCertSha256: string | undefined;
    if (wantsInsecureTls(node, configOptions)) {
      // Read the certificate directly (TUN routes are down at this point) and pin it.
      pinnedCertSha256 = await waitForConnectionTask(fetchLeafCertSha256(serverIps[0] || node.address, node.port, node.sni || node.host || node.address), signal);
      addLog('system', 'info', `Allow insecure: pinned server certificate SHA-256 ${pinnedCertSha256.slice(0, 16)}…`);
    }

    await xrayRunner.start(node, { ...configOptions, pinnedCertSha256 });
    signal.throwIfAborted();

    if (persistedData.routingMode === 'tun') {
      await tunManager.start(binDir, persistedData.socksPort, node.address, serverIps, physicalRoute, signal);
      signal.throwIfAborted();
      // Also enable Windows System Proxy alongside TUN so browsers connect directly
      // to 127.0.0.1:httpPort via HTTP CONNECT (zero OS DNS lag, zero QUIC timeout).
      const proxyResult = await enableSystemProxy(persistedData.httpPort);
      vpnStatus.tunActive = true;
      vpnStatus.systemProxyActive = proxyResult.applied;
      addLog(
        'system',
        'info',
        `Hybrid TUN + System Proxy enabled -> Browsers use 127.0.0.1:${persistedData.httpPort}; all other apps use XrayTUN.`
      );
    } else {
      const proxyResult = await enableSystemProxy(persistedData.httpPort);
      vpnStatus.systemProxyActive = proxyResult.applied;
      vpnStatus.tunActive = false;
      addLog(
        'system',
        'info',
        proxyResult.applied
          ? `Windows System Proxy enabled -> 127.0.0.1:${persistedData.httpPort} (SOCKS5 -> 127.0.0.1:${persistedData.socksPort})`
          : `Local Proxy mode is active -> HTTP 127.0.0.1:${persistedData.httpPort}; SOCKS5 127.0.0.1:${persistedData.socksPort}. Configure each browser or terminal manually; desktop-wide proxy integration is pending.`
      );
    }

    signal.throwIfAborted();
    if (restoreTerminal) {
      const terminalResult = await enableTerminalProxy(persistedData.httpPort, persistedData.socksPort);
      vpnStatus.terminalEnvActive = terminalResult.applied;
      if (terminalResult.message) addLog('system', 'info', terminalResult.message);
      signal.throwIfAborted();
    }
    if (!xrayRunner.isRunning()) throw new Error('Xray stopped while connecting');
    if (persistedData.routingMode === 'tun' && !tunManager.isRunning()) throw new Error('TUN stopped while connecting');
    vpnStatus.connected = true;
    vpnStatus.connecting = false;
    vpnStatus.connectedAt = Date.now();
    vpnStatus.stats.sessionUp = 0;
    vpnStatus.stats.sessionDown = 0;
    recordSessionStart(persistedData, node);
    broadcastData();
    startStatsPolling();
    broadcastStatus();
    void refreshExitGeo();
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

/** Commit routing preferences and their reconnect as one cancellable operation. */
async function changeRoutingConfig(change: () => () => void): Promise<{ ok: boolean; error?: string }> {
  const wasLive = vpnStatus.connected || vpnStatus.connecting;
  return connectionQueue.replace(async (signal) => {
    if (signal.aborted || shuttingDown) return { ok: false, error: 'Settings update cancelled' };
    const rollback = change();
    vpnStatus.routingMode = persistedData.routingMode;
    const result = wasLive || vpnStatus.connected || vpnStatus.connecting
      ? await connectVpnNow(persistedData.activeServerId || undefined, signal)
      : { ok: true };
    if (!result.ok) rollback();
    vpnStatus.routingMode = persistedData.routingMode;
    broadcastData();
    broadcastStatus();
    return result;
  });
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
    void ensureServerGeo();
    if (subscription && reconnect && nodes.some((node) => node.id === activeId) && !signal.aborted) {
      return connectVpnNow(activeId!, signal, restoreTerminal);
    }
    return { ok: true };
  };
  return wasLive ? connectionQueue.replace(update) : connectionQueue.enqueue(update);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(res: http.ServerResponse, data: unknown, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function openDesktopAppWindow(url: string) {
  if (process.platform === 'linux') {
    execFile('xdg-open', [url], { windowsHide: true }, error => {
      if (error) console.error(`Could not open the dashboard with xdg-open: ${error.message}`);
    });
    return;
  }
  if (process.platform !== 'win32') {
    console.log(`Open the DragonForce VPN dashboard at ${url}`);
    return;
  }
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const browserExe of edgePaths) {
    if (fs.existsSync(browserExe)) {
      spawn(browserExe, [`--app=${url}`, '--start-maximized', '--window-position=0,0'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      // Also maximize via Win32 ShowWindowAsync(SW_MAXIMIZE=3) in case an existing browser session restored a smaller window
      const maxScript = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Max { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }'
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 250
  $procs = Get-Process msedge,chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Xray VPN*' -and $_.MainWindowHandle -ne 0 }
  if ($procs) {
    foreach ($p in $procs) { [Win32Max]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null }
    break
  }
}`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', maxScript], () => {});
      return;
    }
  }
  execFile('cmd.exe', ['/c', 'start', '/max', url]);
}

function notifyDesktop(message: Record<string, unknown>) {
  if (process.connected && process.send) process.send(message, () => {});
}

function requestDesktopElevation(): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onDisconnect = () => { cleanup(); reject(new Error('Desktop host disconnected')); };
    const onMessage = (message: any) => {
      if (message?.type !== 'relaunch-admin-result' || message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve();
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send!({ type: 'relaunch-admin', id }, error => {
      if (error) { cleanup(); reject(error); }
    });
  });
}

async function startServer() {
  vpnStatus.isAdmin = await checkIsAdmin();

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      const denied = validateLocalRequest(req, PORT, apiToken);
      if (denied) {
        sendJson(res, { ok: false, error: denied.error }, denied.status);
        return;
      }
      if (shuttingDown && req.method !== 'GET') {
        sendJson(res, { ok: false, error: 'Controller is shutting down' }, 503);
        return;
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        if (!serveAsset(assetsDir, pathname, res, MIME_TYPES)) sendJson(res, { error: 'Not found' }, 404);
        return;
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(uiHtmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: session\ndata: ${JSON.stringify({ apiToken })}\n\n`);
        res.write(`event: status\ndata: ${JSON.stringify(vpnStatus)}\n\n`);
        res.write(`event: data\ndata: ${JSON.stringify(persistedData)}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/init') {
        // isAdmin is determined once at startup; elevation always restarts the process.
        checkBinaries();
        sendJson(res, {
          appId: 'dragonforce-vpn',
          apiToken,
          status: vpnStatus,
          data: persistedData,
          logs,
          terminalCommands: getTerminalProxyCommands(
            persistedData.httpPort,
            persistedData.socksPort
          ),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/connect') {
        const body = await readJsonBody(req);
        const result = await connectVpn(body.serverId ? String(body.serverId) : undefined);
        sendJson(res, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/disconnect') {
        await disconnectVpn();
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/routing-mode') {
        const body = await readJsonBody(req);
        if (body.mode !== 'tun' && body.mode !== 'system_proxy') {
          sendJson(res, { ok: false, error: 'Invalid routing mode' }, 400);
          return;
        }
        if (body.mode === 'tun' && process.platform !== 'win32') {
          sendJson(res, { ok: false, error: 'Full TUN mode is not available on Linux yet. Use Local Proxy mode.' }, 501);
          return;
        }
        const mode = body.mode;
        const result = mode === persistedData.routingMode ? { ok: true } : await changeRoutingConfig(() => {
          const previous = persistedData.routingMode;
          persistedData.routingMode = mode;
          return () => { persistedData.routingMode = previous; };
        });
        sendJson(res, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/terminal-env') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        let terminalResult: ProxyOperationResult | undefined;
        await connectionQueue.enqueue(async () => {
          if (enabled && (!vpnStatus.connected || vpnStatus.connecting)) throw new Error('Connect the VPN before enabling terminal proxy variables.');
          terminalResult = enabled
            ? await enableTerminalProxy(persistedData.httpPort, persistedData.socksPort)
            : await disableTerminalProxy(persistedData.httpPort, persistedData.socksPort);
          vpnStatus.terminalEnvActive = terminalResult.applied;
        });
        const message = terminalResult?.message || (enabled
          ? `Enabled Windows User Proxy Environment Variables (HTTP_PROXY=http://127.0.0.1:${persistedData.httpPort}, ALL_PROXY=socks5://127.0.0.1:${persistedData.socksPort}). Open a new terminal to run npm/git/pip/curl through Xray.`
          : 'Restored the original Windows terminal proxy environment variables.');
        addLog(
          'system',
          'info',
          message
        );
        broadcastStatus();
        sendJson(res, { ok: true, applied: vpnStatus.terminalEnvActive, message: terminalResult?.message });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/relaunch-admin') {
        if (process.platform !== 'win32') {
          sendJson(res, {
            ok: false,
            error: 'Linux privilege elevation is not implemented yet; polkit integration is pending.',
          }, 501);
          return;
        }
        // Keep this controller alive until elevation succeeds. The replacement
        // then uses authenticated takeover to restore networking and release the port.
        if (process.env.VPN_DESKTOP_HOST === '1' && process.send) {
          await requestDesktopElevation();
        } else {
          const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
          const environment = { VPN_APP_ROOT: rootDir, VPN_BIN_DIR: binDir, VPN_DATA_DIR: dataDir, VPN_UI_PORT: String(PORT), NO_OPEN_WINDOW: '1' };
          const bootstrap = [
            ...Object.entries(environment).map(([key, value]) => `$env:${key} = ${quote(value)}`),
            `& ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))}`,
            'exit $LASTEXITCODE',
          ].join('; ');
          const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
          const psCmd = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -WorkingDirectory ${quote(rootDir)} -ArgumentList '-NoProfile -EncodedCommand ${encoded}' -Verb RunAs`;
          await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
        }
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/import-links') {
        const body = await readJsonBody(req);
        const rawText = String(body.rawText || '');
        const { nodes, errors } = parseMultipleLinks(rawText);
        if (nodes.length > 0) {
          persistedData.servers.push(...nodes);
          void ensureServerGeo();
          if (!persistedData.activeServerId) {
            persistedData.activeServerId = nodes[0].id;
            vpnStatus.activeServerId = nodes[0].id;
          }
          addLog('system', 'info', `Imported ${nodes.length} server node(s).`);
          broadcastData();
          broadcastStatus();
        }
        sendJson(res, { importedCount: nodes.length, errors });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/select-server') {
        const body = await readJsonBody(req);
        const serverId = String(body.serverId || '');
        if (!persistedData.servers.some((node) => node.id === serverId)) {
          sendJson(res, { ok: false, error: 'Server not found' }, 404);
          return;
        }
        if (vpnStatus.connected || vpnStatus.connecting) {
          sendJson(res, await connectVpn(serverId));
          return;
        }
        persistedData.activeServerId = serverId;
        vpnStatus.activeServerId = serverId;
        broadcastData();
        broadcastStatus();
        if (vpnStatus.connected) {
          sendJson(res, await connectVpn(serverId));
        } else {
          sendJson(res, { ok: true });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/delete-server') {
        const body = await readJsonBody(req);
        const serverId = String(body.serverId || '');
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
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/update-server') {
        const body = await readJsonBody(req);
        const serverId = String(body.serverId || '');
        const idx = persistedData.servers.findIndex((s) => s.id === serverId);
        if (idx === -1) {
          sendJson(res, { ok: false, error: 'Server not found' }, 404);
          return;
        }
        const current = persistedData.servers[idx];
        let updated;
        try {
          updated = applyServerEdit(current, (body.patch || {}) as ServerEdit);
        } catch (err) {
          sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
          return;
        }
        updated.rawUri = toShareLink(updated);
        if (updated.address !== current.address) {
          updated.geo = null;
          clearServerPing(updated);
        } else if (updated.port !== current.port) {
          clearServerPing(updated);
        }
        const needsPing = updated.ping == null || current.pingStatus === 'measuring';
        if (current.pingStatus === 'measuring') {
          clearServerPing(current);
          clearServerPing(updated);
        }
        persistedData.servers[idx] = updated;
        addLog('system', 'info', `Updated server "${updated.name}".`);
        broadcastData();
        void ensureServerGeo();

        const isLive = (vpnStatus.connected || vpnStatus.connecting) && vpnStatus.activeServerId === serverId;
        if (isLive) {
          const result = await connectVpn(serverId);
          sendJson(res, { ...result, reconnected: true });
        } else {
          if (needsPing) void measureServerPings([updated], broadcastData);
          sendJson(res, { ok: true, reconnected: false });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ping-server') {
        const body = await readJsonBody(req);
        const serverId = String(body.serverId || '');
        const node = persistedData.servers.find((s) => s.id === serverId);
        if (!node) {
          sendJson(res, { ok: false, error: 'Server not found' }, 404);
          return;
        }
        await measureServerPings([node], broadcastData);
        sendJson(res, { ping: node.ping, pingStatus: node.pingStatus, pingError: node.pingError, pingCheckedAt: node.pingCheckedAt });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ping-all') {
        await measureServerPings(persistedData.servers, broadcastData);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/test-tunnel') {
        if (!vpnStatus.connected) {
          sendJson(res, { ok: false, latencyMs: -1, error: 'VPN is not connected' });
          return;
        }
        const testRes = await testProxyConnectivity(persistedData.httpPort);
        if (testRes.ok) {
          addLog(
            'system',
            'info',
            `End-to-end tunnel verified! HTTP 204 latency via Xray: ${testRes.latencyMs} ms`
          );
        } else {
          addLog('system', 'warn', `Tunnel verification failed: ${testRes.error}`);
        }
        sendJson(res, testRes);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/add-subscription') {
        const body = await readJsonBody(req);
        const subUrl = String(body.url || '');
        const subName = body.name ? String(body.name) : undefined;
        try {
          addLog('system', 'info', `Fetching subscription ${subUrl} ...`);
          const { subscription, nodes } = await fetchSubscription(subUrl, undefined, subName);
          persistedData.subscriptions.push(subscription);
          persistedData.servers.push(...nodes);
          void ensureServerGeo();
          if (!persistedData.activeServerId && nodes.length > 0) {
            persistedData.activeServerId = nodes[0].id;
            vpnStatus.activeServerId = nodes[0].id;
          }
          addLog(
            'system',
            'info',
            `Subscription "${subscription.name}" added (${nodes.length} nodes).`
          );
          broadcastData();
          broadcastStatus();
          sendJson(res, { ok: true, count: nodes.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog('system', 'error', `Subscription error: ${msg}`);
          sendJson(res, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/refresh-subscription') {
        const body = await readJsonBody(req);
        const subId = String(body.subId || '');
        const existing = persistedData.subscriptions.find((s) => s.id === subId);
        if (!existing) {
          sendJson(res, { ok: false, error: 'Subscription not found' });
          return;
        }
        try {
          const { subscription, nodes } = await fetchSubscription(
            existing.url,
            existing.id,
            existing.name
          );
          const result = await updateSubscriptionNodes(subId, subscription, nodes);
          sendJson(res, { ...result, count: nodes.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sync-all-subscriptions') {
        let syncedSubs = 0;
        let totalNodes = 0;
        const errors: string[] = [];
        for (const existing of [...persistedData.subscriptions]) {
          try {
            const { subscription, nodes } = await fetchSubscription(
              existing.url,
              existing.id,
              existing.name
            );
            const result = await updateSubscriptionNodes(existing.id, subscription, nodes);
            if (!result.ok) throw new Error(result.error || 'Reconnection failed after subscription refresh');
            syncedSubs++;
            totalNodes += nodes.length;
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
            addLog(
              'system',
              'warn',
              `Failed syncing "${existing.name}": ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        void ensureServerGeo();
        if (!persistedData.servers.some((s) => s.id === persistedData.activeServerId)) {
          persistedData.activeServerId = persistedData.servers[0]?.id || null;
          vpnStatus.activeServerId = persistedData.activeServerId;
        }
        broadcastData();
        broadcastStatus();
        sendJson(res, { ok: errors.length === 0, error: errors.join('; ') || undefined, syncedSubs, totalNodes });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/update-subscription') {
        const body = await readJsonBody(req);
        const subId = String(body.subId || '');
        const sub = persistedData.subscriptions.find((s) => s.id === subId);
        if (!sub) {
          sendJson(res, { ok: false, error: 'Subscription not found' }, 404);
          return;
        }
        if (typeof body.name === 'string' && body.name.trim()) {
          sub.name = body.name.trim();
        }
        if (typeof body.url === 'string' && body.url.trim().startsWith('http')) {
          sub.url = body.url.trim();
        }
        if (body.totalBytes !== undefined) {
          const tb = Number(body.totalBytes);
          sub.totalBytes = Number.isFinite(tb) && tb > 0 ? tb : undefined;
        }
        if (body.expireTimestamp !== undefined) {
          const exp = Number(body.expireTimestamp);
          sub.expireTimestamp = Number.isFinite(exp) && exp > 0 ? exp : undefined;
        }
        broadcastData();
        sendJson(res, { ok: true, subscription: sub });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ping-subscription') {
        const body = await readJsonBody(req);
        const subId = String(body.subId || '');
        const subNodes = persistedData.servers.filter((s) => s.subscriptionId === subId);
        await measureServerPings(subNodes, broadcastData);
        sendJson(res, { ok: true, count: subNodes.length });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/delete-subscription') {
        const body = await readJsonBody(req);
        const subId = String(body.subId || '');
        sendJson(res, await updateSubscriptionNodes(subId, null));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/server-config') {
        const body = await readJsonBody(req);
        const serverId = String(body.serverId || '');
        const node = persistedData.servers.find((s) => s.id === serverId);
        if (!node) {
          sendJson(res, { json: '' });
          return;
        }
        const cfg = generateXrayConfig(node, {
          socksPort: persistedData.socksPort,
          httpPort: persistedData.httpPort,
          bypassLan: persistedData.bypassLan,
          allowInsecureDefault: persistedData.allowInsecureDefault,
          tunMode: persistedData.routingMode === 'tun',
          mux: Boolean(persistedData.muxEnabled),
          adblock: ensureAdBlockState(persistedData.adblock).config,
          splitTunnel: ensureSplitTunnelConfig(persistedData.splitTunnel),
          accessLogPath,
        });
        sendJson(res, { json: JSON.stringify(cfg, null, 2) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        let next;
        try { next = validateNetworkSettings(persistedData, body, PORT); }
        catch (error) { sendJson(res, { ok: false, error: String(error instanceof Error ? error.message : error) }, 400); return; }
        const networkChanged = Object.entries(next).some(([key, value]) => value !== getNetworkSettings(persistedData)[key as keyof typeof next]);
        if (body.theme === 'light' || body.theme === 'dark') {
          persistedData.theme = body.theme;
        }
        let result: { ok: boolean; error?: string } = { ok: true };
        if (networkChanged) {
          const wasLive = vpnStatus.connected || vpnStatus.connecting;
          result = await connectionQueue.replace(async (signal) => {
            const previous = getNetworkSettings(persistedData);
            const updated = validateNetworkSettings(persistedData, body, PORT);
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
        sendJson(res, {
          ...result,
          theme: persistedData.theme,
          terminalCommands: getTerminalProxyCommands(
            persistedData.httpPort,
            persistedData.socksPort
          ),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/speedtest/start') {
        if (activeSpeedTest) {
          sendJson(res, { ok: false, error: 'A speed test is already running' });
          return;
        }
        sendJson(res, { ok: true });
        void runSpeedTest();
        return;
      }

      if (req.method === 'POST' && pathname === '/api/speedtest/cancel') {
        activeSpeedTest?.abort();
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/usage/datacap') {
        const body = await readJsonBody(req);
        const h = ensureUsageHistory(persistedData);
        if (typeof body.enabled === 'boolean') h.dataCap.enabled = body.enabled;
        if (body.period === 'daily' || body.period === 'monthly') h.dataCap.period = body.period;
        if (typeof body.limitBytes === 'number' && body.limitBytes > 0) {
          h.dataCap.limitBytes = Math.round(body.limitBytes);
        }
        if (typeof body.alertPct === 'number' && body.alertPct >= 10 && body.alertPct <= 100) {
          h.dataCap.alertPct = Math.round(body.alertPct);
        }
        if (typeof body.autoDisconnect === 'boolean') {
          h.dataCap.autoDisconnect = body.autoDisconnect;
        }
        h.dataCap.lastWarnPeriod = undefined;
        h.dataCap.lastLimitPeriod = undefined;
        broadcastData();
        sendJson(res, { ok: true, dataCap: h.dataCap });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/usage/reset') {
        const body = await readJsonBody(req);
        await connectionQueue.enqueue(async () => {
          const h = ensureUsageHistory(persistedData);
          if (body.serverId && typeof body.serverId === 'string') {
            delete h.perServer[body.serverId];
          } else {
            // Anchor to the current cumulative Xray counters before clearing history.
            // Generation changes discard any poll that was already in flight.
            const resumePolling = vpnStatus.connected;
            stopStatsPolling();
            if (resumePolling) {
              const counters = await xrayRunner.queryTrafficStats();
              if (!counters) {
                startStatsPolling(false);
                throw new Error('Could not read current traffic counters; usage was not reset.');
              }
              lastPolledUp = counters.upBytes;
              lastPolledDown = counters.downBytes;
            }
            persistedData.totalUp = 0;
            persistedData.totalDown = 0;
            vpnStatus.stats.totalUp = 0;
            vpnStatus.stats.totalDown = 0;
            persistedData.usageHistory = {
              minutes: [],
              hours: [],
              days: [],
              perServer: {},
              dataCap: { ...(h.dataCap || defaultDataCap()), lastWarnPeriod: undefined, lastLimitPeriod: undefined },
              peakDownSpeed: 0,
              peakUpSpeed: 0,
            };
            if (resumePolling) startStatsPolling(false);
          }
          broadcastData();
          broadcastStatus();
        });
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/qr/clipboard') {
        const result = await readWindowsClipboard();
        sendJson(res, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/qr/capture-screen') {
        const body = await readJsonBody(req);
        const delayMs = typeof body.delayMs === 'number' ? body.delayMs : 0;
        const result = await captureWindowsScreen(delayMs);
        sendJson(res, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/qr/preview') {
        const body = await readJsonBody(req);
        const rawText = String(body.rawText || '').trim();
        if (!rawText) {
          sendJson(res, { ok: false, error: 'Empty QR payload' });
          return;
        }
        const parsed = parseMultipleLinks(rawText);
        if (parsed.nodes.length > 0) {
          sendJson(res, {
            ok: true,
            kind: 'servers',
            nodes: parsed.nodes.map((n) => ({
              name: n.name,
              protocol: n.protocol,
              address: n.address,
              port: n.port,
              network: n.network,
              security: n.security,
              sni: n.sni || null,
              host: n.host || null,
              rawUri: toShareLink(n),
            })),
          });
          return;
        }
        if (/^https?:\/\/\S+$/i.test(rawText)) {
          sendJson(res, {
            ok: true,
            kind: 'subscription',
            url: rawText,
          });
          return;
        }
        sendJson(res, {
          ok: false,
          kind: 'unknown',
          rawText,
          error: parsed.errors[0] || 'QR code does not contain a vless://, vmess://, or subscription URL',
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/onboarding') {
        const body = await readJsonBody(req);
        persistedData.onboardingCompleted = body.completed !== undefined ? Boolean(body.completed) : true;
        broadcastData();
        sendJson(res, { ok: true, onboardingCompleted: persistedData.onboardingCompleted });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/adblock/config') {
        const body = await readJsonBody(req);
        const cleanHost = (value: unknown) => sanitizeDomainEntry(String(value || ''));
        for (const field of ['addBlockedDomain', 'addWhitelistedDomain']) {
          if (body[field] && !cleanHost(body[field])) {
            sendJson(res, { ok: false, error: 'Enter a valid domain name' }, 400);
            return;
          }
        }
        const result = await changeRoutingConfig(() => {
          const ab = ensureAdBlockState(persistedData.adblock);
          const previous = ab.config;
          const cfg = { ...previous, customBlockedDomains: [...previous.customBlockedDomains], whitelistedDomains: [...previous.whitelistedDomains] };
          for (const field of ['enabled', 'blockYoutubeAds', 'blockAds', 'blockTrackers', 'blockMalware', 'adguardDns'] as const) {
            if (typeof body[field] === 'boolean') cfg[field] = body[field];
          }
          if (body.addBlockedDomain) {
            const domain = cleanHost(body.addBlockedDomain);
            if (!cfg.customBlockedDomains.includes(domain)) cfg.customBlockedDomains.unshift(domain);
          }
          if (body.removeBlockedDomain) cfg.customBlockedDomains = cfg.customBlockedDomains.filter(domain => domain !== cleanHost(body.removeBlockedDomain));
          if (body.addWhitelistedDomain) {
            const domain = cleanHost(body.addWhitelistedDomain);
            if (!cfg.whitelistedDomains.includes(domain)) cfg.whitelistedDomains.unshift(domain);
          }
          if (body.removeWhitelistedDomain) cfg.whitelistedDomains = cfg.whitelistedDomains.filter(domain => domain !== cleanHost(body.removeWhitelistedDomain));
          persistedData.adblock = { ...ab, config: cfg };
          return () => { persistedData.adblock!.config = previous; };
        });
        sendJson(res, { ...result, adblock: persistedData.adblock });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/adblock/test') {
        const ab = ensureAdBlockState(persistedData.adblock);
        if (!vpnStatus.connected || vpnStatus.connecting || !xrayRunner.isRunning()) {
          sendJson(res, { ok: false, error: 'Connect the VPN before running live Shield verification.' });
          return;
        }
        if (!ab.config.enabled) {
          sendJson(res, { ok: false, error: 'Enable Ad Shield first to run the live block test.' });
          return;
        }
        const testTargets: string[] = [];
        if (ab.config.blockYoutubeAds) {
          testTargets.push('ads.youtube.com', 'video-ad-stats.googlesyndication.com', 'googleads.g.doubleclick.net');
        }
        if (ab.config.blockAds) {
          testTargets.push('pagead2.googlesyndication.com', 'taboola.com', 'outbrain.com');
        }
        if (ab.config.blockTrackers) {
          testTargets.push('scorecardresearch.com', 'hotjar.com');
        }
        if (ab.config.blockMalware) {
          testTargets.push('coinhive.com');
        }
        for (const c of ab.config.customBlockedDomains.slice(0, 2)) {
          testTargets.push(c);
        }

        const targets = [...new Set(testTargets)].filter(host => evaluateDomainShield(host, ab.config).blocked);
        if (targets.length === 0) {
          sendJson(res, { ok: false, error: 'All shield categories are currently turned off.' });
          return;
        }

        const generation = statsGeneration;
        const result = await verifyAdBlock(persistedData.httpPort, accessLogPath, targets);
        if (!vpnStatus.connected || generation !== statsGeneration) {
          sendJson(res, { ok: false, error: 'Connection changed during Shield verification. Try again.' });
          return;
        }
        // Only the regular log watcher updates traffic statistics; never synthesize events.
        persistedData.adblock = ensureAdBlockState(persistedData.adblock);
        adblockWatcher.poll(accessLogPath, persistedData.adblock);
        addLog('system', result.ok ? 'info' : 'warn', result.ok
          ? `Ad Shield verified: Xray logged ${result.blockedCount} blocked test probes.`
          : result.error || 'Shield verification incomplete.');
        broadcastData();
        sendJson(res, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/adblock/reset') {
        const ab = ensureAdBlockState(persistedData.adblock);
        persistedData.adblock = ensureAdBlockState({
          config: ab.config,
          totalBlocked: 0,
          savedBytes: 0,
          savedMs: 0,
          byCategory: {
            youtube_ads: { blocked: 0, savedBytes: 0 },
            ad_networks: { blocked: 0, savedBytes: 0 },
            trackers: { blocked: 0, savedBytes: 0 },
            malware: { blocked: 0, savedBytes: 0 },
            custom: { blocked: 0, savedBytes: 0 },
          },
          hourly: [],
          topDomains: {},
          recentBlocked: [],
        });
        broadcastData();
        sendJson(res, { ok: true, adblock: persistedData.adblock });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/adblock/check-domain') {
        const body = await readJsonBody(req);
        const rawDomain = String(body.domain || '').trim();
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateDomainShield(rawDomain, ab.config);
        sendJson(res, { ok: true, simulation: true, domain: rawDomain, ...verdict });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/split-tunnel/config') {
        const body = await readJsonBody(req);
        const parsedTarget = typeof body.addTarget === 'string' ? parseSplitTargetInput(body.addTarget) : null;
        if (body.addTarget && !parsedTarget) {
          sendJson(res, { ok: false, error: 'Enter a valid domain (e.g. netflix.com, *.lk) or IPv4/IPv6 address or CIDR range.' }, 400);
          return;
        }
        const result = await changeRoutingConfig(() => {
          const previous = persistedData.splitTunnel;
          const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
          let changed = false;

          if (body.mode === 'off' || body.mode === 'bypass' || body.mode === 'vpn_only') {
            if (st.mode !== body.mode) {
              st.mode = body.mode;
              changed = true;
            }
          }

          if (typeof body.presetId === 'string' && PRESET_IDS.includes(body.presetId as SplitTunnelPresetId)) {
            const pid = body.presetId as SplitTunnelPresetId;
            const nextVal = typeof body.enabled === 'boolean' ? body.enabled : !st.presets[pid];
            if (st.presets[pid] !== nextVal) {
              st.presets[pid] = nextVal;
              if (nextVal && st.mode === 'off') {
                st.mode = 'bypass';
              }
              changed = true;
            }
          }

          if (parsedTarget) {
            const parsed = parsedTarget;
            if (parsed.kind === 'domain') {
              if (!st.customDomains.includes(parsed.value)) {
                st.customDomains.push(parsed.value);
                if (st.mode === 'off') st.mode = 'bypass';
                changed = true;
              }
            } else {
              if (!st.customIps.includes(parsed.value)) {
                st.customIps.push(parsed.value);
                if (st.mode === 'off') st.mode = 'bypass';
                changed = true;
              }
            }
          }

          if (typeof body.removeDomain === 'string') {
            const d = body.removeDomain.trim().toLowerCase();
            const before = st.customDomains.length;
            st.customDomains = st.customDomains.filter((item) => item !== d);
            if (st.customDomains.length !== before) changed = true;
          }

          if (typeof body.removeIp === 'string') {
            const ip = body.removeIp.trim();
            const before = st.customIps.length;
            st.customIps = st.customIps.filter((item) => item !== ip);
            if (st.customIps.length !== before) changed = true;
          }

          persistedData.splitTunnel = st;
          if (changed && (vpnStatus.connected || vpnStatus.connecting)) {
            addLog('system', 'info', `Reloading Xray routing rules for Split Tunneling (mode: ${st.mode})...`);
          }
          return () => { persistedData.splitTunnel = previous; };
        });
        sendJson(res, { ...result, splitTunnel: persistedData.splitTunnel });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/split-tunnel/test') {
        const body = await readJsonBody(req);
        const rawTarget = String(body.target || '').trim();
        const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateSplitTunnelRoute(
          rawTarget,
          st,
          ab.config,
          persistedData.bypassLan
        );
        sendJson(res, { ok: true, ...verdict });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/clear-logs') {
        logs.length = 0;
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/shutdown') {
        shuttingDown = true;
        try { await disconnectVpn(); }
        catch (error) { shuttingDown = false; throw error; }
        sendJson(res, { ok: true });
        setTimeout(() => process.exit(0), 150);
        return;
      }

      sendJson(res, { error: 'Not found' }, 404);
    } catch (err) {
      sendJson(
        res,
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  server.once('listening', () => {
    // Read state only after the previous controller has saved and released ownership.
    loadPersistedData();
    checkBinaries();
    addLog(
      'system',
      'info',
      process.platform === 'linux'
        ? 'Xray VPN Client ready. Local Proxy mode is available; Linux TUN and desktop-wide proxy integration are pending.'
        : `Xray VPN Client ready. Admin privileges: ${vpnStatus.isAdmin ? 'YES (Full TUN Mode Ready)' : 'NO (System Proxy & Terminal Env Ready)'}`
    );
    void refreshOriginGeo();
    void ensureServerGeo();
    void measureServerPings(persistedData.servers, broadcastData);
    const appUrl = `http://127.0.0.1:${PORT}`;
    console.log(`\n========================================================`);
    console.log(`  DragonForce Vpn is running at: ${appUrl}`);
    console.log(process.platform === 'linux'
      ? '  Linux Mode: Local Proxy Ready (TUN pending)'
      : `  Admin Mode (TUN Ready): ${vpnStatus.isAdmin ? 'YES' : 'NO'}`);
    console.log(`========================================================\n`);
    notifyDesktop({ type: 'ready' });
    if (!process.env.NO_OPEN_WINDOW) {
      openDesktopAppWindow(appUrl);
    }
  });
  const listen = () => server.listen(PORT, '127.0.0.1');
  let takeoverAttempted = false;
  server.on('error', async (error: NodeJS.ErrnoException) => {
    try {
      if (error.code !== 'EADDRINUSE' || takeoverAttempted) throw error;
      takeoverAttempted = true;
      console.log(`Waiting for the previous controller on port ${PORT} to restore networking...`);
      await stopPreviousController(PORT);
      listen();
    } catch (error) {
      console.error(`Could not start DragonForce VPN: ${String(error)}`);
      process.exit(1);
    }
  });
  listen();
}

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await disconnectVpn();
    process.exit(0);
  } catch (error) {
    shuttingDown = false;
    addLog('system', 'error', String(error));
    notifyDesktop({ type: 'shutdown-error', error: String(error) });
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
if (process.env.VPN_DESKTOP_HOST === '1' && process.send) {
  process.on('message', (message: any) => {
    if (message?.type === 'shutdown') void gracefulShutdown();
  });
  process.once('disconnect', gracefulShutdown);
}

void startServer().catch(error => {
  console.error(`Could not start DragonForce VPN: ${String(error)}`);
  process.exit(1);
});
