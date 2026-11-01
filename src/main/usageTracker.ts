import type {
  DataCapConfig,
  PersistedData,
  ServerNode,
  UsageBucket,
  UsageHistory,
} from './types.ts';

const MAX_MINUTE_BUCKETS = 60;
const MAX_HOUR_BUCKETS = 168; // 7 days of hourly buckets
const MAX_DAY_BUCKETS = 90;   // 90 days of daily buckets

export function defaultDataCap(): DataCapConfig {
  return {
    enabled: false,
    period: 'monthly',
    limitBytes: 50 * 1024 * 1024 * 1024, // 50 GB default
    alertPct: 80,
    autoDisconnect: false,
  };
}

export function formatDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatMonthPrefix(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function ensureUsageHistory(data: PersistedData, now = Date.now()): UsageHistory {
  if (!data.usageHistory) {
    const history: UsageHistory = {
      minutes: [],
      hours: [],
      days: [],
      perServer: {},
      dataCap: defaultDataCap(),
      peakDownSpeed: 0,
      peakUpSpeed: 0,
    };

    // Backfill existing cumulative traffic on first migration so past usage is preserved
    const existingUp = Math.max(0, Number(data.totalUp || 0));
    const existingDown = Math.max(0, Number(data.totalDown || 0));
    if (existingUp > 0 || existingDown > 0) {
      const hourStart = Math.floor(now / 3600_000) * 3600_000;
      const dayKey = formatDayKey(now);
      history.hours.push({
        key: String(hourStart),
        timestamp: hourStart,
        upBytes: existingUp,
        downBytes: existingDown,
      });
      history.days.push({
        key: dayKey,
        timestamp: new Date(dayKey + 'T00:00:00').getTime() || now,
        upBytes: existingUp,
        downBytes: existingDown,
      });
      const node = data.servers.find((s) => s.id === data.activeServerId) || data.servers[0];
      if (node) {
        history.perServer[node.id] = {
          serverId: node.id,
          serverName: node.name,
          address: `${node.address}:${node.port}`,
          protocol: node.protocol,
          countryCode: node.geo?.countryCode ?? null,
          country: node.geo?.country ?? null,
          subscriptionId: node.subscriptionId ?? null,
          upBytes: existingUp,
          downBytes: existingDown,
          connectedSeconds: 0,
          sessions: 1,
          lastUsedAt: now,
        };
      }
    }

    data.usageHistory = history;
    return history;
  }

  const h = data.usageHistory;
  if (!Array.isArray(h.minutes)) h.minutes = [];
  if (!Array.isArray(h.hours)) h.hours = [];
  if (!Array.isArray(h.days)) h.days = [];
  if (!h.perServer || typeof h.perServer !== 'object') h.perServer = {};
  if (!h.dataCap || typeof h.dataCap !== 'object') h.dataCap = defaultDataCap();
  if (typeof h.peakDownSpeed !== 'number') h.peakDownSpeed = 0;
  if (typeof h.peakUpSpeed !== 'number') h.peakUpSpeed = 0;

  // Sync server names/flags for current servers
  for (const s of data.servers) {
    const rec = h.perServer[s.id];
    if (rec) {
      rec.serverName = s.name;
      rec.address = `${s.address}:${s.port}`;
      rec.protocol = s.protocol;
      if (s.geo?.countryCode) rec.countryCode = s.geo.countryCode;
      if (s.geo?.country) rec.country = s.geo.country;
      if (s.subscriptionId) rec.subscriptionId = s.subscriptionId;
    }
  }

  return h;
}

function addToBucketList(
  list: UsageBucket[],
  key: string,
  timestamp: number,
  upDelta: number,
  downDelta: number,
  maxLen: number
): void {
  const last = list[list.length - 1];
  if (last && last.key === key) {
    last.upBytes += upDelta;
    last.downBytes += downDelta;
    return;
  }
  const existing = list.find((b) => b.key === key);
  if (existing) {
    existing.upBytes += upDelta;
    existing.downBytes += downDelta;
    return;
  }
  list.push({
    key,
    timestamp,
    upBytes: upDelta,
    downBytes: downDelta,
  });
  if (list.length > maxLen) {
    list.splice(0, list.length - maxLen);
  }
}

export function recordSessionStart(data: PersistedData, node: ServerNode, now = Date.now()): void {
  const h = ensureUsageHistory(data, now);
  const existing = h.perServer[node.id];
  if (existing) {
    existing.serverName = node.name;
    existing.address = `${node.address}:${node.port}`;
    existing.protocol = node.protocol;
    existing.countryCode = node.geo?.countryCode ?? existing.countryCode ?? null;
    existing.country = node.geo?.country ?? existing.country ?? null;
    existing.subscriptionId = node.subscriptionId ?? existing.subscriptionId ?? null;
    existing.sessions = (existing.sessions || 0) + 1;
    existing.lastUsedAt = now;
  } else {
    h.perServer[node.id] = {
      serverId: node.id,
      serverName: node.name,
      address: `${node.address}:${node.port}`,
      protocol: node.protocol,
      countryCode: node.geo?.countryCode ?? null,
      country: node.geo?.country ?? null,
      subscriptionId: node.subscriptionId ?? null,
      upBytes: 0,
      downBytes: 0,
      connectedSeconds: 0,
      sessions: 1,
      lastUsedAt: now,
    };
  }
}

export interface CapEvaluation {
  warnTriggered: boolean;
  limitReached: boolean;
  usedBytes: number;
  limitBytes: number;
  pct: number;
  periodLabel: string;
}

export function evaluateDataCap(h: UsageHistory, now = Date.now()): CapEvaluation {
  const cap = h.dataCap;
  const dayKey = formatDayKey(now);
  const monthPrefix = formatMonthPrefix(now);
  const periodKey = cap.period === 'daily' ? dayKey : monthPrefix;
  const periodLabel = cap.period === 'daily' ? 'today' : 'this month';

  let usedBytes = 0;
  if (cap.period === 'daily') {
    const today = h.days.find((d) => d.key === dayKey);
    usedBytes = today ? today.upBytes + today.downBytes : 0;
  } else {
    for (const d of h.days) {
      if (d.key.startsWith(monthPrefix)) {
        usedBytes += d.upBytes + d.downBytes;
      }
    }
  }

  const limitBytes = Math.max(1, cap.limitBytes || 1);
  const pct = (usedBytes / limitBytes) * 100;

  if (!cap.enabled) {
    return { warnTriggered: false, limitReached: false, usedBytes, limitBytes, pct, periodLabel };
  }

  let warnTriggered = false;
  let limitReached = false;

  if (pct >= 100 && cap.lastLimitPeriod !== periodKey) {
    cap.lastLimitPeriod = periodKey;
    cap.lastWarnPeriod = periodKey;
    limitReached = true;
  } else if (pct >= cap.alertPct && cap.lastWarnPeriod !== periodKey) {
    cap.lastWarnPeriod = periodKey;
    warnTriggered = true;
  }

  return { warnTriggered, limitReached, usedBytes, limitBytes, pct, periodLabel };
}

export function recordTrafficTick(
  data: PersistedData,
  node: ServerNode | undefined,
  upDelta: number,
  downDelta: number,
  elapsedSec = 1,
  now = Date.now()
): CapEvaluation {
  const h = ensureUsageHistory(data, now);

  if (downDelta > h.peakDownSpeed) h.peakDownSpeed = downDelta;
  if (upDelta > h.peakUpSpeed) h.peakUpSpeed = upDelta;

  if (upDelta > 0 || downDelta > 0) {
    const minStart = Math.floor(now / 60_000) * 60_000;
    const hourStart = Math.floor(now / 3600_000) * 3600_000;
    const dayKey = formatDayKey(now);
    const dayStart = new Date(dayKey + 'T00:00:00').getTime() || now;

    addToBucketList(h.minutes, String(minStart), minStart, upDelta, downDelta, MAX_MINUTE_BUCKETS);
    addToBucketList(h.hours, String(hourStart), hourStart, upDelta, downDelta, MAX_HOUR_BUCKETS);
    addToBucketList(h.days, dayKey, dayStart, upDelta, downDelta, MAX_DAY_BUCKETS);
  }

  if (node) {
    let rec = h.perServer[node.id];
    if (!rec) {
      rec = {
        serverId: node.id,
        serverName: node.name,
        address: `${node.address}:${node.port}`,
        protocol: node.protocol,
        countryCode: node.geo?.countryCode ?? null,
        country: node.geo?.country ?? null,
        subscriptionId: node.subscriptionId ?? null,
        upBytes: 0,
        downBytes: 0,
        connectedSeconds: 0,
        sessions: 1,
        lastUsedAt: now,
      };
      h.perServer[node.id] = rec;
    }
    rec.upBytes += upDelta;
    rec.downBytes += downDelta;
    rec.connectedSeconds += elapsedSec;
    rec.lastUsedAt = now;
    if (node.geo?.countryCode) rec.countryCode = node.geo.countryCode;
    if (node.geo?.country) rec.country = node.geo.country;
  }

  return evaluateDataCap(h, now);
}
