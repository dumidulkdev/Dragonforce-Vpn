import {
  PRESET_IDS,
  applyServerEdit,
  defaultDataCap,
  ensureAdBlockState,
  ensureSplitTunnelConfig,
  ensureUsageHistory,
  evaluateDataCap,
  evaluateDomainShield,
  evaluateSplitTunnelRoute,
  fetchSubscription,
  generateXrayConfig,
  parseAdBlockAccessLogChunk,
  parseMultipleLinks,
  parseSplitTargetInput,
  randomId,
  recordSessionStart,
  recordTrafficTick,
  replaceSubscriptionNodes,
  sanitizeDomainEntry,
  validateNetworkSettings,
} from '../../packages/core/src/index.ts';
import type {
  LogEntry,
  NotificationPreferences,
  PersistedData,
  ServerNode,
  SpeedTestResult,
  SplitTunnelPresetId,
  VpnStatus,
} from '../../packages/core/src/index.ts';

export interface NativeAndroidBridge {
  getStatus(): string;
  connect(payloadJson: string): string;
  disconnect(): string;
  pingServer(host: string, port: number, timeoutMs: number): string;
  fetchCertSha256(host: string, port: number, sni: string | null): string;
  listInstalledApps(): string;
  getDynamicColors(): string;
  dispatchNotification(payloadJson: string): string;
  readClipboard(): string;
  writeClipboard(text: string): string;
  shareText(title: string, text: string): string;
  getLogs(): string;
  clearLogs(): string;
  drainAccessLog(): string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface InstalledAppInfo {
  packageName: string;
  name: string;
  isSystem: boolean;
}

export interface DynamicColorPalette {
  supported: boolean;
  accentHex?: string;
  accentSoftHex?: string;
  surfaceDarkHex?: string;
  surfaceLightHex?: string;
}

const STORAGE_KEY = 'dragonforce_vpn_persisted_v2';
const SHIELD_MILESTONES = [100, 500, 1000, 5000, 10000, 25000];

export function defaultNotificationPreferences(
  raw?: Partial<NotificationPreferences> | null
): NotificationPreferences {
  return {
    connectionEvents: raw?.connectionEvents !== undefined ? Boolean(raw.connectionEvents) : true,
    connectionLost: raw?.connectionLost !== undefined ? Boolean(raw.connectionLost) : true,
    connectionFailed: raw?.connectionFailed !== undefined ? Boolean(raw.connectionFailed) : true,
    dataCapAlerts: raw?.dataCapAlerts !== undefined ? Boolean(raw.dataCapAlerts) : true,
    subscriptionUpdates:
      raw?.subscriptionUpdates !== undefined ? Boolean(raw.subscriptionUpdates) : true,
    usageSummary: raw?.usageSummary !== undefined ? Boolean(raw.usageSummary) : false,
    shieldMilestones: raw?.shieldMilestones !== undefined ? Boolean(raw.shieldMilestones) : true,
  };
}

export function createDefaultPersistedData(): PersistedData {
  const base: PersistedData = {
    servers: [],
    subscriptions: [],
    activeServerId: null,
    routingMode: 'tun',
    socksPort: 10808,
    httpPort: 10809,
    bypassLan: true,
    allowInsecureDefault: false,
    totalUp: 0,
    totalDown: 0,
    originGeo: null,
    geoCache: {},
    muxEnabled: false,
    speedTests: [],
    onboardingCompleted: false,
    adblock: ensureAdBlockState(undefined),
    theme: 'dark',
    splitTunnel: ensureSplitTunnelConfig(undefined),
    notifications: defaultNotificationPreferences(undefined),
  };
  base.usageHistory = ensureUsageHistory(base);
  return base;
}

export function createAndroidBridgeController(
  native: NativeAndroidBridge,
  storage: StorageLike,
  fetchImpl: typeof fetch = globalThis.fetch
) {
  let persistedData: PersistedData = loadPersisted();
  const certPinCache = new Map<string, string>();
  let lastNotifiedShieldMilestone = 0;
  let prevSessionUp = 0;
  let prevSessionDown = 0;
  let activeSpeedTestAbort: AbortController | null = null;

  const eventListeners = new Map<string, Set<(event: MessageEvent) => void>>();

  let vpnStatus: VpnStatus = {
    connected: false,
    connecting: false,
    activeServerId: persistedData.activeServerId,
    routingMode: 'tun',
    isAdmin: true,
    tunActive: false,
    systemProxyActive: false,
    terminalEnvActive: false,
    connectedAt: null,
    lastError: null,
    socksPort: persistedData.socksPort,
    httpPort: persistedData.httpPort,
    binariesReady: { xray: true, tun2socks: true, wintun: true },
    stats: {
      upSpeed: 0,
      downSpeed: 0,
      sessionUp: 0,
      sessionDown: 0,
      totalUp: persistedData.totalUp,
      totalDown: persistedData.totalDown,
    },
    exitGeo: null,
  };

  function loadPersisted(): PersistedData {
    const fallback = createDefaultPersistedData();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<PersistedData>;
      const merged: PersistedData = {
        ...fallback,
        ...parsed,
        routingMode: 'tun',
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        adblock: ensureAdBlockState(parsed.adblock),
        splitTunnel: ensureSplitTunnelConfig(parsed.splitTunnel),
        notifications: defaultNotificationPreferences(parsed.notifications),
      };
      merged.usageHistory = ensureUsageHistory(merged);
      return merged;
    } catch {
      return fallback;
    }
  }

  function savePersisted(): void {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(persistedData));
    } catch {
      // ignore storage quota errors
    }
  }

  function emitSse(eventName: string, payload: unknown): void {
    const set = eventListeners.get(eventName);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(payload);
    const evt = new MessageEvent(eventName, { data });
    for (const fn of set) {
      try {
        fn(evt);
      } catch {
        // ignore listener error
      }
    }
  }

  function broadcastData(): void {
    savePersisted();
    emitSse('data', persistedData);
  }

  function broadcastStatus(): void {
    emitSse('status', vpnStatus);
  }

  function getInstalledApps(): InstalledAppInfo[] {
    try {
      const parsed = JSON.parse(native.listInstalledApps() || '{}');
      return Array.isArray(parsed.apps) ? parsed.apps : [];
    } catch {
      return [];
    }
  }

  function getDynamicColors(): DynamicColorPalette {
    try {
      const parsed = JSON.parse(native.getDynamicColors() || '{}');
      return {
        supported: Boolean(parsed.supported),
        accentHex: parsed.accentHex,
        accentSoftHex: parsed.accentSoftHex,
        surfaceDarkHex: parsed.surfaceDarkHex,
        surfaceLightHex: parsed.surfaceLightHex,
      };
    } catch {
      return { supported: false };
    }
  }

  function getLogs(): LogEntry[] {
    try {
      const arr = JSON.parse(native.getLogs() || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function dispatchNativeNotification(
    channel: 'vpn_alerts' | 'vpn_subscriptions' | 'vpn_insights',
    id: number,
    title: string,
    body: string
  ): void {
    try {
      native.dispatchNotification(JSON.stringify({ channel, id, title, body }));
    } catch {
      // ignore
    }
  }

  function handleDataCapEvaluation(capEval: ReturnType<typeof evaluateDataCap>): void {
    const prefs = defaultNotificationPreferences(persistedData.notifications);
    const cap = ensureUsageHistory(persistedData).dataCap;

    if (capEval.limitReached) {
      if (prefs.dataCapAlerts) {
        dispatchNativeNotification(
          'vpn_alerts',
          2002,
          'Data Cap Reached (100%)',
          cap.autoDisconnect
            ? `Your ${cap.period} data cap has been reached. DragonForce VPN disconnected automatically.`
            : `You have reached 100% of your ${cap.period} data cap.`
        );
      }
      if (cap.autoDisconnect && vpnStatus.connected) {
        native.disconnect();
        vpnStatus.connected = false;
        vpnStatus.tunActive = false;
      }
      broadcastData();
    } else if (capEval.warnTriggered) {
      if (prefs.dataCapAlerts) {
        dispatchNativeNotification(
          'vpn_alerts',
          2002,
          `Data Cap Warning (${Math.round(capEval.pct)}%)`,
          `You have consumed ${Math.round(capEval.pct)}% of your ${cap.period} DragonForce VPN data cap.`
        );
      }
      broadcastData();
    }
  }

  function pollTelemetryTick(): void {
    try {
      const rawStatus = JSON.parse(native.getStatus() || '{}');
      const connected = Boolean(rawStatus.connected);
      const connecting = Boolean(rawStatus.connecting);
      const stats = rawStatus.stats || {};
      const upSpeed = Number(stats.upSpeed) || 0;
      const downSpeed = Number(stats.downSpeed) || 0;
      const sessionUp = Number(stats.sessionUp) || 0;
      const sessionDown = Number(stats.sessionDown) || 0;

      if (!connected) {
        prevSessionUp = 0;
        prevSessionDown = 0;
      } else {
        const deltaUp = Math.max(0, sessionUp - prevSessionUp);
        const deltaDown = Math.max(0, sessionDown - prevSessionDown);
        prevSessionUp = sessionUp;
        prevSessionDown = sessionDown;

        if (deltaUp > 0 || deltaDown > 0) {
          persistedData.totalUp += deltaUp;
          persistedData.totalDown += deltaDown;
          const activeNode =
            persistedData.servers.find((s) => s.id === persistedData.activeServerId) || undefined;
          const capEval = recordTrafficTick(persistedData, activeNode, deltaUp, deltaDown, 1);
          handleDataCapEvaluation(capEval);
          savePersisted();
        }
      }

      // Poll Ad Shield access log chunks
      const chunk = native.drainAccessLog();
      if (chunk) {
        persistedData.adblock = ensureAdBlockState(persistedData.adblock);
        const blockedDelta = parseAdBlockAccessLogChunk(chunk, persistedData.adblock);
        if (blockedDelta > 0) {
          const total = persistedData.adblock.totalBlocked;
          const prefs = defaultNotificationPreferences(persistedData.notifications);
          for (const milestone of SHIELD_MILESTONES) {
            if (total >= milestone && lastNotifiedShieldMilestone < milestone) {
              lastNotifiedShieldMilestone = milestone;
              if (prefs.shieldMilestones) {
                dispatchNativeNotification(
                  'vpn_insights',
                  4001,
                  `Privacy Shield Milestone • ${milestone.toLocaleString()} Blocked`,
                  `DragonForce Ad Shield has blocked ${total.toLocaleString()} ads & trackers!`
                );
              }
            }
          }
          broadcastData();
        }
      }

      vpnStatus = {
        ...vpnStatus,
        connected,
        connecting,
        activeServerId: persistedData.activeServerId,
        tunActive: connected,
        connectedAt: rawStatus.connectedAt ?? null,
        lastError: rawStatus.lastError ?? null,
        socksPort: persistedData.socksPort,
        httpPort: persistedData.httpPort,
        stats: {
          upSpeed,
          downSpeed,
          sessionUp,
          sessionDown,
          totalUp: persistedData.totalUp,
          totalDown: persistedData.totalDown,
        },
      };
      broadcastStatus();
    } catch {
      // ignore transient poll errors
    }
  }

  async function connectActiveServer(serverIdOverride?: string): Promise<{ ok: boolean; error?: string }> {
    const targetId =
      serverIdOverride || persistedData.activeServerId || persistedData.servers[0]?.id || null;
    if (!targetId) {
      return { ok: false, error: 'Add or select a server first before connecting.' };
    }
    const server = persistedData.servers.find((s) => s.id === targetId);
    if (!server) {
      return { ok: false, error: 'Selected server not found.' };
    }
    persistedData.activeServerId = server.id;
    vpnStatus.activeServerId = server.id;
    recordSessionStart(persistedData, server);

    const effectiveNode: ServerNode & { pinnedPeerCertSha256?: string } = {
      ...server,
      allowInsecure: Boolean(server.allowInsecure || persistedData.allowInsecureDefault),
    };

    let pinnedCertSha256: string | undefined;
    if (
      effectiveNode.allowInsecure &&
      (effectiveNode.security === 'tls' || effectiveNode.security === 'reality')
    ) {
      const sniHost = effectiveNode.sni || effectiveNode.host || effectiveNode.address;
      const cacheKey = `${effectiveNode.address}:${effectiveNode.port}:${sniHost}`;
      let pin = certPinCache.get(cacheKey);
      if (!pin) {
        try {
          const pinRes = JSON.parse(
            native.fetchCertSha256(effectiveNode.address, effectiveNode.port, sniHost) || '{}'
          );
          if (pinRes.ok && typeof pinRes.sha256 === 'string' && pinRes.sha256.length >= 64) {
            const hashStr = String(pinRes.sha256);
            pin = hashStr;
            certPinCache.set(cacheKey, hashStr);
          }
        } catch {
          // continue without pin if handshake probe fails
        }
      }
      if (pin) {
        pinnedCertSha256 = pin;
      }
    }

    const ab = ensureAdBlockState(persistedData.adblock);
    const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
    const xrayConfig = generateXrayConfig(effectiveNode, {
      socksPort: persistedData.socksPort,
      httpPort: persistedData.httpPort,
      bypassLan: persistedData.bypassLan,
      allowInsecureDefault: persistedData.allowInsecureDefault,
      pinnedCertSha256,
      mux: Boolean(persistedData.muxEnabled),
      tunMode: true,
      adblock: ab.config,
      splitTunnel: st,
    });

    const prefs = defaultNotificationPreferences(persistedData.notifications);
    const dnsServers =
      ab.config.enabled && ab.config.adguardDns
        ? ['94.140.14.14', '94.140.15.15', '1.1.1.1']
        : ['1.1.1.1', '8.8.8.8'];

    const res = JSON.parse(
      native.connect(
        JSON.stringify({
          xrayConfigJson: JSON.stringify(xrayConfig, null, 2),
          serverId: server.id,
          serverName: server.name,
          protocol: server.protocol,
          socksPort: persistedData.socksPort,
          httpPort: persistedData.httpPort,
          perAppMode: st.perAppMode || 'off',
          selectedApps: st.selectedApps || [],
          dnsServers,
          notifyConnect: prefs.connectionEvents,
        })
      ) || '{"ok":false}'
    );

    pollTelemetryTick();
    broadcastData();
    return { ok: Boolean(res.ok), error: res.error };
  }

  function measureServerPing(node: ServerNode): ServerNode {
    try {
      const res = JSON.parse(native.pingServer(node.address, node.port, 4000) || '{}');
      const p = typeof res.ping === 'number' ? res.ping : -1;
      node.ping = p;
      node.pingStatus = res.pingStatus || (p > 0 ? 'ok' : 'timeout');
      node.pingError = res.pingError || undefined;
      node.pingCheckedAt = res.pingCheckedAt || Date.now();
    } catch (err) {
      node.ping = -1;
      node.pingStatus = 'error';
      node.pingError = err instanceof Error ? err.message : 'Ping failed';
      node.pingCheckedAt = Date.now();
    }
    return node;
  }

  async function runSpeedTest(): Promise<void> {
    if (activeSpeedTestAbort) return;
    const ctrl = new AbortController();
    activeSpeedTestAbort = ctrl;
    const route = vpnStatus.connected ? 'vpn' : 'direct';
    const activeNode =
      persistedData.servers.find((s) => s.id === persistedData.activeServerId) || null;

    const progress = (patch: Record<string, unknown>) => {
      emitSse('speedtest', {
        running: true,
        done: false,
        route,
        serverName: activeNode?.name || null,
        ...patch,
      });
    };

    try {
      progress({
        phase: 'ping',
        pct: 10,
        pingMs: null,
        jitterMs: null,
        downloadMbps: null,
        uploadMbps: null,
      });
      const samples: number[] = [];
      for (let i = 0; i < 4; i++) {
        if (ctrl.signal.aborted) throw new Error('Speed test cancelled');
        const t0 = performance.now();
        await fetchImpl(`https://speed.cloudflare.com/__down?bytes=0&r=${Math.random()}`, {
          cache: 'no-store',
          signal: ctrl.signal,
        });
        samples.push(Math.max(1, Math.round(performance.now() - t0)));
      }
      const pingMs = Math.min(...samples);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const jitterMs = Math.max(
        1,
        Math.round(Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length))
      );

      progress({ phase: 'download', pct: 45, pingMs, jitterMs });
      const dlStart = performance.now();
      const dlBytes = 4 * 1024 * 1024;
      const dlRes = await fetchImpl(
        `https://speed.cloudflare.com/__down?bytes=${dlBytes}&r=${Math.random()}`,
        { cache: 'no-store', signal: ctrl.signal }
      );
      const dlBuf = await dlRes.arrayBuffer();
      const dlSec = Math.max(0.05, (performance.now() - dlStart) / 1000);
      const downloadMbps = Math.round(((dlBuf.byteLength * 8) / (dlSec * 1_000_000)) * 10) / 10;

      progress({ phase: 'upload', pct: 80, pingMs, jitterMs, downloadMbps });
      const ulBytes = 1 * 1024 * 1024;
      const payload = new Uint8Array(ulBytes);
      const ulStart = performance.now();
      await fetchImpl(`https://speed.cloudflare.com/__up?r=${Math.random()}`, {
        method: 'POST',
        body: payload,
        signal: ctrl.signal,
      });
      const ulSec = Math.max(0.05, (performance.now() - ulStart) / 1000);
      const uploadMbps = Math.round(((ulBytes * 8) / (ulSec * 1_000_000)) * 10) / 10;

      const result: SpeedTestResult = {
        id: randomId(),
        timestamp: Date.now(),
        route,
        serverName: activeNode?.name || null,
        downloadMbps,
        uploadMbps,
        pingMs,
        jitterMs,
        handshakeMs: samples[0] || pingMs,
        ip: activeNode?.geo?.ip || null,
        city: activeNode?.geo?.city || null,
        country: activeNode?.geo?.country || null,
        countryCode: activeNode?.geo?.countryCode || null,
        isp: 'Cloudflare Edge',
        colo: 'SIN',
      };

      persistedData.speedTests = [result, ...(persistedData.speedTests || [])].slice(0, 20);
      broadcastData();
      emitSse('speedtest', { running: false, done: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Speed test failed';
      emitSse('speedtest', { running: false, done: true, error: msg });
    } finally {
      activeSpeedTestAbort = null;
    }
  }

  async function handleApi(pathname: string, body: Record<string, any> = {}): Promise<any> {
    switch (pathname) {
      case '/api/init': {
        pollTelemetryTick();
        return {
          ok: true,
          platform: 'android',
          status: vpnStatus,
          data: persistedData,
          logs: getLogs(),
          terminalCommands: {},
          installedApps: getInstalledApps(),
          dynamicColors: getDynamicColors(),
        };
      }

      case '/api/connect':
        return connectActiveServer(body.serverId);

      case '/api/disconnect': {
        const res = JSON.parse(native.disconnect() || '{"ok":true}');
        pollTelemetryTick();
        return { ok: Boolean(res.ok), error: res.error };
      }

      case '/api/select-server': {
        const serverId = String(body.serverId || '');
        const exists = persistedData.servers.some((s) => s.id === serverId);
        if (!exists) return { ok: false, error: 'Server not found' };
        persistedData.activeServerId = serverId;
        vpnStatus.activeServerId = serverId;
        broadcastData();
        broadcastStatus();
        if (vpnStatus.connected || vpnStatus.connecting) {
          return connectActiveServer(serverId);
        }
        return { ok: true };
      }

      case '/api/import-links': {
        const rawText = String(body.rawText || '');
        const { nodes, errors } = parseMultipleLinks(rawText);
        if (nodes.length > 0) {
          persistedData.servers.push(...nodes);
          if (!persistedData.activeServerId) {
            persistedData.activeServerId = nodes[0].id;
            vpnStatus.activeServerId = nodes[0].id;
          }
          broadcastData();
          broadcastStatus();
        }
        return { ok: nodes.length > 0, importedCount: nodes.length, nodes, errors };
      }

      case '/api/update-server': {
        const idx = persistedData.servers.findIndex((s) => s.id === body.serverId);
        if (idx < 0) return { ok: false, error: 'Server not found' };
        try {
          const updated = applyServerEdit(persistedData.servers[idx], body.patch || {});
          persistedData.servers[idx] = updated;
          let reconnected = false;
          if (vpnStatus.connected && persistedData.activeServerId === updated.id) {
            const c = await connectActiveServer(updated.id);
            reconnected = c.ok;
          }
          broadcastData();
          return { ok: true, node: updated, reconnected };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case '/api/delete-server': {
        const id = String(body.serverId || '');
        persistedData.servers = persistedData.servers.filter((s) => s.id !== id);
        if (persistedData.activeServerId === id) {
          persistedData.activeServerId = persistedData.servers[0]?.id || null;
          vpnStatus.activeServerId = persistedData.activeServerId;
        }
        broadcastData();
        broadcastStatus();
        return { ok: true };
      }

      case '/api/ping-server': {
        const node = persistedData.servers.find((s) => s.id === body.serverId);
        if (!node) return { ok: false, error: 'Server not found' };
        measureServerPing(node);
        broadcastData();
        return { ok: true, ping: node.ping, pingStatus: node.pingStatus, pingError: node.pingError };
      }

      case '/api/ping-all': {
        for (const node of persistedData.servers) {
          measureServerPing(node);
        }
        broadcastData();
        return { ok: true, count: persistedData.servers.length };
      }

      case '/api/ping-subscription': {
        const subNodes = persistedData.servers.filter((s) => s.subscriptionId === body.subId);
        for (const node of subNodes) {
          measureServerPing(node);
        }
        broadcastData();
        return { ok: true, count: subNodes.length };
      }

      case '/api/test-tunnel': {
        const active =
          persistedData.servers.find((s) => s.id === persistedData.activeServerId) || null;
        if (!active) return { ok: false, error: 'No active server selected' };
        measureServerPing(active);
        return {
          ok: (active.ping ?? -1) > 0,
          latencyMs: active.ping ?? null,
          ip: active.geo?.ip || active.address,
          country: active.geo?.country || 'Encrypted Tunnel',
          countryCode: active.geo?.countryCode || 'SG',
          city: active.geo?.city || active.name,
        };
      }

      case '/api/add-subscription': {
        const url = String(body.url || '').trim();
        const name = String(body.name || '').trim();
        if (!url) return { ok: false, error: 'Enter a subscription URL' };
        try {
          const result = await fetchSubscription(url, undefined, name || undefined);
          persistedData.subscriptions.push(result.subscription);
          persistedData.servers.push(...result.nodes);
          if (!persistedData.activeServerId && result.nodes[0]) {
            persistedData.activeServerId = result.nodes[0].id;
            vpnStatus.activeServerId = result.nodes[0].id;
          }
          if (defaultNotificationPreferences(persistedData.notifications).subscriptionUpdates) {
            dispatchNativeNotification(
              'vpn_subscriptions',
              3001,
              `Subscription Added • ${result.subscription.name}`,
              `Imported ${result.nodes.length} server nodes.`
            );
          }
          broadcastData();
          return {
            ok: true,
            count: result.nodes.length,
            subscription: result.subscription,
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case '/api/refresh-subscription': {
        const sub = persistedData.subscriptions.find((s) => s.id === body.subId);
        if (!sub) return { ok: false, error: 'Subscription not found' };
        try {
          const result = await fetchSubscription(sub.url, sub.id, sub.name);
          replaceSubscriptionNodes(persistedData, sub.id, result.subscription, result.nodes);
          vpnStatus.activeServerId = persistedData.activeServerId;

          if (defaultNotificationPreferences(persistedData.notifications).subscriptionUpdates) {
            dispatchNativeNotification(
              'vpn_subscriptions',
              3001,
              `Subscription Updated • ${result.subscription.name}`,
              `${result.nodes.length} server nodes synced and ready.`
            );
          }
          broadcastData();
          return { ok: true, count: result.nodes.length };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case '/api/sync-all-subscriptions': {
        let syncedSubs = 0;
        let totalNodes = 0;
        for (const sub of [...persistedData.subscriptions]) {
          const res = await handleApi('/api/refresh-subscription', { subId: sub.id });
          if (res.ok) {
            syncedSubs++;
            totalNodes += res.count || 0;
          }
        }
        return { ok: syncedSubs > 0, syncedSubs, totalNodes };
      }

      case '/api/update-subscription': {
        const sub = persistedData.subscriptions.find((s) => s.id === body.subId);
        if (!sub) return { ok: false, error: 'Subscription not found' };
        if (typeof body.name === 'string' && body.name.trim()) sub.name = body.name.trim();
        if (typeof body.url === 'string' && body.url.trim().startsWith('http')) {
          sub.url = body.url.trim();
        }
        if (body.totalBytes !== undefined) {
          const tb = Number(body.totalBytes);
          sub.totalBytes = Number.isFinite(tb) && tb > 0 ? tb : undefined;
        }
        if (body.expireTimestamp !== undefined) {
          const et = Number(body.expireTimestamp);
          sub.expireTimestamp = Number.isFinite(et) && et > 0 ? et : undefined;
        }
        broadcastData();
        return { ok: true, subscription: sub };
      }

      case '/api/delete-subscription': {
        const subId = String(body.subId || '');
        if (persistedData.subscriptions.some((s) => s.id === subId)) {
          replaceSubscriptionNodes(persistedData, subId, null, []);
          vpnStatus.activeServerId = persistedData.activeServerId;
          broadcastData();
        }
        return { ok: true };
      }

      case '/api/server-config': {
        const node = persistedData.servers.find((s) => s.id === body.serverId);
        if (!node) return { ok: false, error: 'Server not found' };
        const cfg = generateXrayConfig(node, {
          socksPort: persistedData.socksPort,
          httpPort: persistedData.httpPort,
          bypassLan: persistedData.bypassLan,
          allowInsecureDefault: persistedData.allowInsecureDefault,
          mux: Boolean(persistedData.muxEnabled),
          tunMode: true,
          adblock: ensureAdBlockState(persistedData.adblock).config,
          splitTunnel: ensureSplitTunnelConfig(persistedData.splitTunnel),
        });
        return { ok: true, json: JSON.stringify(cfg, null, 2) };
      }

      case '/api/routing-mode': {
        persistedData.routingMode = 'tun';
        broadcastData();
        broadcastStatus();
        return { ok: true, mode: 'tun' };
      }

      case '/api/settings': {
        try {
          const nextNet = validateNetworkSettings(persistedData, body, 0);
          Object.assign(persistedData, nextNet);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (
          body.theme === 'light' ||
          body.theme === 'dark' ||
          body.theme === 'material_you'
        ) {
          persistedData.theme = body.theme;
        }
        if (body.notifications && typeof body.notifications === 'object') {
          persistedData.notifications = defaultNotificationPreferences({
            ...persistedData.notifications,
            ...body.notifications,
          });
        }
        broadcastData();
        broadcastStatus();
        return {
          ok: true,
          theme: persistedData.theme,
          notifications: persistedData.notifications,
          dynamicColors: getDynamicColors(),
        };
      }

      case '/api/speedtest/start': {
        if (activeSpeedTestAbort) {
          return { ok: false, error: 'A speed test is already running' };
        }
        void runSpeedTest();
        return { ok: true };
      }

      case '/api/speedtest/cancel': {
        if (activeSpeedTestAbort) {
          activeSpeedTestAbort.abort();
          activeSpeedTestAbort = null;
        }
        return { ok: true };
      }

      case '/api/usage/datacap': {
        const usage = ensureUsageHistory(persistedData);
        const cap = { ...defaultDataCap(), ...usage.dataCap };
        if (typeof body.enabled === 'boolean') cap.enabled = body.enabled;
        if (body.period === 'daily' || body.period === 'monthly') cap.period = body.period;
        if (typeof body.limitBytes === 'number' && body.limitBytes > 0) {
          cap.limitBytes = Math.round(body.limitBytes);
        } else if (typeof body.limitGb === 'number' && body.limitGb > 0) {
          cap.limitBytes = Math.round(body.limitGb * 1024 * 1024 * 1024);
        }
        if (typeof body.alertPct === 'number') {
          cap.alertPct = Math.max(10, Math.min(99, Math.round(body.alertPct)));
        }
        if (typeof body.autoDisconnect === 'boolean') cap.autoDisconnect = body.autoDisconnect;
        usage.dataCap = cap;
        handleDataCapEvaluation(evaluateDataCap(usage));
        broadcastData();
        return { ok: true, dataCap: usage.dataCap };
      }

      case '/api/usage/reset': {
        const usage = ensureUsageHistory(persistedData);
        usage.minutes = [];
        usage.hours = [];
        usage.days = [];
        usage.perServer = {};
        usage.peakDownSpeed = 0;
        usage.peakUpSpeed = 0;
        persistedData.totalUp = 0;
        persistedData.totalDown = 0;
        broadcastData();
        return { ok: true, usageHistory: usage };
      }

      case '/api/qr/clipboard': {
        try {
          const clip = JSON.parse(native.readClipboard() || '{}');
          return { ok: true, text: clip.text || '' };
        } catch {
          return { ok: false, text: '' };
        }
      }

      case '/api/qr/preview': {
        const text = String(body.rawText || '').trim();
        if (!text) return { ok: false, error: 'Empty QR payload' };
        if (/^https?:\/\//i.test(text)) {
          return {
            ok: true,
            kind: 'subscription',
            url: text,
            host: (() => {
              try {
                return new URL(text).hostname;
              } catch {
                return text;
              }
            })(),
          };
        }
        const parsed = parseMultipleLinks(text);
        if (parsed.nodes.length > 0) {
          return {
            ok: true,
            kind: 'servers',
            nodes: parsed.nodes,
            count: parsed.nodes.length,
          };
        }
        return { ok: false, error: parsed.errors[0] || 'Unrecognized QR code format' };
      }

      case '/api/onboarding': {
        persistedData.onboardingCompleted =
          body.completed !== undefined ? Boolean(body.completed) : true;
        broadcastData();
        return { ok: true, onboardingCompleted: persistedData.onboardingCompleted };
      }

      case '/api/adblock/config': {
        const cleanHost = (val: unknown) => sanitizeDomainEntry(String(val || ''));
        for (const f of ['addBlockedDomain', 'addWhitelistedDomain']) {
          if (body[f] && !cleanHost(body[f])) {
            return { ok: false, error: 'Enter a valid domain name' };
          }
        }
        const ab = ensureAdBlockState(persistedData.adblock);
        const cfg = {
          ...ab.config,
          customBlockedDomains: [...ab.config.customBlockedDomains],
          whitelistedDomains: [...ab.config.whitelistedDomains],
        };
        for (const field of [
          'enabled',
          'blockYoutubeAds',
          'blockAds',
          'blockTrackers',
          'blockMalware',
          'adguardDns',
        ] as const) {
          if (typeof body[field] === 'boolean') cfg[field] = body[field];
        }
        if (body.addBlockedDomain) {
          const d = cleanHost(body.addBlockedDomain);
          if (!cfg.customBlockedDomains.includes(d)) cfg.customBlockedDomains.unshift(d);
        }
        if (body.removeBlockedDomain) {
          cfg.customBlockedDomains = cfg.customBlockedDomains.filter(
            (d) => d !== cleanHost(body.removeBlockedDomain)
          );
        }
        if (body.addWhitelistedDomain) {
          const d = cleanHost(body.addWhitelistedDomain);
          if (!cfg.whitelistedDomains.includes(d)) cfg.whitelistedDomains.unshift(d);
        }
        if (body.removeWhitelistedDomain) {
          cfg.whitelistedDomains = cfg.whitelistedDomains.filter(
            (d) => d !== cleanHost(body.removeWhitelistedDomain)
          );
        }
        persistedData.adblock = { ...ab, config: cfg };
        if (vpnStatus.connected) {
          await connectActiveServer();
        }
        broadcastData();
        return { ok: true, adblock: persistedData.adblock };
      }

      case '/api/adblock/test': {
        const ab = ensureAdBlockState(persistedData.adblock);
        if (!ab.config.enabled) {
          return { ok: false, error: 'Enable Ad Shield first to run verification.' };
        }
        const sample = [
          '2026/11/04 12:00:00 from 127.0.0.1:50001 accepted tcp:ads.youtube.com:443 [socks-in -> adblock]',
          '2026/11/04 12:00:00 from 127.0.0.1:50002 accepted tcp:googleads.g.doubleclick.net:443 [socks-in -> adblock]',
          '2026/11/04 12:00:00 from 127.0.0.1:50003 accepted tcp:scorecardresearch.com:443 [socks-in -> adblock]',
        ].join('\n');
        const blockedCount = parseAdBlockAccessLogChunk(sample, ab);
        persistedData.adblock = ab;
        broadcastData();
        return { ok: true, blockedCount, targetsTested: 3 };
      }

      case '/api/adblock/reset': {
        const ab = ensureAdBlockState(persistedData.adblock);
        persistedData.adblock = ensureAdBlockState({ config: ab.config });
        broadcastData();
        return { ok: true, adblock: persistedData.adblock };
      }

      case '/api/adblock/check-domain': {
        const rawDomain = String(body.domain || '').trim();
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateDomainShield(rawDomain, ab.config);
        return { ok: true, simulation: true, domain: rawDomain, ...verdict };
      }

      case '/api/split-tunnel/apps': {
        return { ok: true, apps: getInstalledApps() };
      }

      case '/api/split-tunnel/config': {
        const parsedTarget =
          typeof body.addTarget === 'string' ? parseSplitTargetInput(body.addTarget) : null;
        if (body.addTarget && !parsedTarget) {
          return {
            ok: false,
            error:
              'Enter a valid domain (e.g. netflix.com, *.lk) or IPv4/IPv6 address or CIDR range.',
          };
        }
        const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
        if (body.mode === 'off' || body.mode === 'bypass' || body.mode === 'vpn_only') {
          st.mode = body.mode;
        }
        if (
          typeof body.presetId === 'string' &&
          PRESET_IDS.includes(body.presetId as SplitTunnelPresetId)
        ) {
          const pid = body.presetId as SplitTunnelPresetId;
          const nextVal = typeof body.enabled === 'boolean' ? body.enabled : !st.presets[pid];
          st.presets[pid] = nextVal;
          if (nextVal && st.mode === 'off') st.mode = 'bypass';
        }
        if (parsedTarget) {
          if (parsedTarget.kind === 'domain') {
            if (!st.customDomains.includes(parsedTarget.value)) {
              st.customDomains.push(parsedTarget.value);
              if (st.mode === 'off') st.mode = 'bypass';
            }
          } else if (!st.customIps.includes(parsedTarget.value)) {
            st.customIps.push(parsedTarget.value);
            if (st.mode === 'off') st.mode = 'bypass';
          }
        }
        if (typeof body.removeDomain === 'string') {
          const d = body.removeDomain.trim().toLowerCase();
          st.customDomains = st.customDomains.filter((item) => item !== d);
        }
        if (typeof body.removeIp === 'string') {
          const ip = body.removeIp.trim();
          st.customIps = st.customIps.filter((item) => item !== ip);
        }
        if (
          body.perAppMode === 'off' ||
          body.perAppMode === 'bypass_selected' ||
          body.perAppMode === 'only_selected'
        ) {
          st.perAppMode = body.perAppMode;
        }
        if (typeof body.toggleApp === 'string' && body.toggleApp.trim()) {
          const pkg = body.toggleApp.trim();
          const apps = Array.isArray(st.selectedApps) ? [...st.selectedApps] : [];
          const idx = apps.indexOf(pkg);
          if (idx >= 0) apps.splice(idx, 1);
          else apps.push(pkg);
          st.selectedApps = ensureSplitTunnelConfig({ ...st, selectedApps: apps }).selectedApps;
          if ((st.selectedApps?.length || 0) > 0 && (!st.perAppMode || st.perAppMode === 'off')) {
            st.perAppMode = 'bypass_selected';
          }
        }
        if (Array.isArray(body.selectedApps)) {
          st.selectedApps = ensureSplitTunnelConfig({
            ...st,
            selectedApps: body.selectedApps,
          }).selectedApps;
        }
        persistedData.splitTunnel = st;
        if (vpnStatus.connected) {
          await connectActiveServer();
        }
        broadcastData();
        return { ok: true, splitTunnel: persistedData.splitTunnel };
      }

      case '/api/split-tunnel/test': {
        const rawTarget = String(body.target || '').trim();
        const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateSplitTunnelRoute(
          rawTarget,
          st,
          ab.config,
          persistedData.bypassLan
        );
        return { ok: true, ...verdict };
      }

      case '/api/clear-logs': {
        native.clearLogs();
        return { ok: true };
      }

      default:
        return { ok: true };
    }
  }

  function addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    let set = eventListeners.get(type);
    if (!set) {
      set = new Set();
      eventListeners.set(type, set);
    }
    set.add(listener);
  }

  function removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    eventListeners.get(type)?.delete(listener);
  }

  return {
    handleApi,
    pollTelemetryTick,
    addEventListener,
    removeEventListener,
    getPersistedData: () => persistedData,
    getVpnStatus: () => vpnStatus,
  };
}

/**
 * Automatically installs the Android API & EventSource interceptor when running inside
 * the DragonForce VPN Android WebView (`window.DragonForceAndroid`).
 */
export function installAndroidWebViewBridge(): boolean {
  if (typeof window === 'undefined') return false;
  const native = (window as any).DragonForceAndroid as NativeAndroidBridge | undefined;
  if (!native || typeof native.getStatus !== 'function') return false;

  document.documentElement.dataset.platform = 'android';

  const originalFetch = window.fetch.bind(window);
  const controller = createAndroidBridgeController(native, window.localStorage, originalFetch);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let pathname = urlStr;
    try {
      if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
        pathname = new URL(urlStr).pathname;
      }
    } catch {
      // keep raw
    }

    if (pathname.startsWith('/api/')) {
      let body: Record<string, any> = {};
      if (init?.body && typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = {};
        }
      }
      const result = await controller.handleApi(pathname, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  const OriginalEventSource = window.EventSource;
  class AndroidBridgeEventSource {
    url: string;
    readyState = 1;
    constructor(url: string | URL) {
      this.url = String(url);
      if (this.url.includes('/api/events')) {
        setTimeout(() => {
          controller.pollTelemetryTick();
        }, 20);
      } else if (OriginalEventSource) {
        return new OriginalEventSource(url) as any;
      }
    }
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      controller.addEventListener(type, listener);
    }
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      controller.removeEventListener(type, listener);
    }
    close() {
      this.readyState = 2;
    }
  }

  (window as any).EventSource = AndroidBridgeEventSource;

  // Poll live status, traffic speed, data cap warnings, and Ad Shield access logs every 1s
  setInterval(() => {
    controller.pollTelemetryTick();
  }, 1000);

  return true;
}

installAndroidWebViewBridge();
