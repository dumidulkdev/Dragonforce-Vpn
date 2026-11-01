import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  AdBlockCategory,
  AdBlockConfig,
  AdBlockHourlyBucket,
  AdBlockState,
} from './types.ts';

export const YOUTUBE_AD_DOMAINS = [
  'ads.youtube.com',
  'ad.youtube.com',
  'video-ad-stats.googlesyndication.com',
  'pagead2.googlesyndication.com',
  'tpc.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'pubads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'static.doubleclick.net',
  'cm.g.doubleclick.net',
  'ad.doubleclick.net',
  'doubleclick.net',
  'googleadservices.com',
  'www.googleadservices.com',
  's0.2mdn.net',
  '2mdn.net',
  'imasdk.googleapis.com',
  'innovid.com',
  'fwmrm.net',
  'moatads.com',
  'doubleverify.com',
  'iasds01.com',
  'flashtalking.com',
];

export const AD_NETWORK_DOMAINS = [
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'criteo.net',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'smartadserver.com',
  'amazon-adsystem.com',
  'adsrvr.org',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'exoclick.com',
  'adsterra.com',
  'juicyads.com',
  'mgid.com',
  'revcontent.com',
  'zedo.com',
  'adform.net',
  'advertising.com',
  'mediavine.com',
  'adthrive.com',
  'carbonads.com',
  'buysellads.com',
];

export const TRACKER_DOMAINS = [
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'luckyorange.com',
  'crazyegg.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.io',
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'kochava.com',
  'singular.net',
  'clarity.ms',
  'omtrdc.net',
  'demdex.net',
  'krxd.net',
  'bluekai.com',
  'lotame.com',
  'chartbeat.com',
  'parsely.com',
  'statcounter.com',
  'histats.com',
];

export const MALWARE_DOMAINS = [
  'coinhive.com',
  'crypto-loot.com',
  'coin-hive.com',
  'jsecoin.com',
  'minero.cc',
  'webminepool.com',
  'authedmine.com',
  'cryptoloot.pro',
  'ppoi.org',
  'miner.pr0gramm.com',
];

export function defaultAdBlockConfig(): AdBlockConfig {
  return {
    enabled: true,
    blockYoutubeAds: true,
    blockAds: true,
    blockTrackers: true,
    blockMalware: true,
    adguardDns: true,
    customBlockedDomains: [],
    whitelistedDomains: [],
  };
}

function buildInitialHourlyBuckets(now = Date.now()): AdBlockHourlyBucket[] {
  const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
  const buckets: AdBlockHourlyBucket[] = [];
  for (let i = 23; i >= 0; i--) {
    const ts = currentHour - i * 3_600_000;
    buckets.push({
      key: String(ts),
      timestamp: ts,
      blocked: 0,
      savedBytes: 0,
    });
  }
  return buckets;
}

export function ensureAdBlockState(existing?: Partial<AdBlockState> | null): AdBlockState {
  const cfg: AdBlockConfig = {
    ...defaultAdBlockConfig(),
    ...(existing?.config || {}),
    customBlockedDomains: Array.isArray(existing?.config?.customBlockedDomains)
      ? existing!.config!.customBlockedDomains
      : [],
    whitelistedDomains: Array.isArray(existing?.config?.whitelistedDomains)
      ? existing!.config!.whitelistedDomains
      : [],
  };

  const defaultByCat: Record<AdBlockCategory, { blocked: number; savedBytes: number }> = {
    youtube_ads: { blocked: 0, savedBytes: 0 },
    ad_networks: { blocked: 0, savedBytes: 0 },
    trackers: { blocked: 0, savedBytes: 0 },
    malware: { blocked: 0, savedBytes: 0 },
    custom: { blocked: 0, savedBytes: 0 },
  };

  const byCategory = {
    ...defaultByCat,
    ...(existing?.byCategory || {}),
  };

  let hourly = Array.isArray(existing?.hourly) && existing!.hourly.length > 0
    ? existing!.hourly
    : buildInitialHourlyBuckets();

  // Ensure current hour bucket exists
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const lastBucket = hourly[hourly.length - 1];
  if (!lastBucket || lastBucket.timestamp < currentHour) {
    const map = new Map(hourly.map((b) => [b.timestamp, b]));
    const updated: AdBlockHourlyBucket[] = [];
    for (let i = 23; i >= 0; i--) {
      const ts = currentHour - i * 3_600_000;
      updated.push(
        map.get(ts) || {
          key: String(ts),
          timestamp: ts,
          blocked: 0,
          savedBytes: 0,
        }
      );
    }
    hourly = updated;
  }

  return {
    config: cfg,
    totalBlocked: Number(existing?.totalBlocked || 0),
    savedBytes: Number(existing?.savedBytes || 0),
    savedMs: Number(existing?.savedMs || 0),
    byCategory,
    hourly,
    topDomains: existing?.topDomains && typeof existing.topDomains === 'object' ? existing.topDomains : {},
    recentBlocked: Array.isArray(existing?.recentBlocked) ? existing!.recentBlocked.slice(0, 60) : [],
  };
}

/**
 * Builds Xray-core routing rules for the AdBlock & Privacy Shield.
 */
export function buildAdBlockRoutingRules(
  config?: AdBlockConfig | null,
  splitRouting: { rules: Array<Record<string, unknown>>; defaultOutboundTag: 'proxy' | 'direct' } = {
    rules: [], defaultOutboundTag: 'proxy',
  }
): Array<Record<string, unknown>> {
  if (!config || !config.enabled) return [];

  const rules: Array<Record<string, unknown>> = [];

  // Whitelisting bypasses Shield, while retaining the normal split-routing policy.
  const whitelist = (config.whitelistedDomains || [])
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (whitelist.length > 0) {
    for (const rule of splitRouting.rules) {
      let domains = whitelist.map((d) => `domain:${d}`);
      if (Array.isArray(rule.domain)) {
        domains = [];
        // Split domain rules are suffix matches. Intersect each pair using the
        // narrower suffix so a broad whitelist still respects subdomain rules.
        for (const allowed of whitelist) {
          for (const domainRule of rule.domain as string[]) {
            const selected = domainRule.slice('domain:'.length);
            if (allowed === selected || allowed.endsWith(`.${selected}`)) domains.push(`domain:${allowed}`);
            else if (selected.endsWith(`.${allowed}`)) domains.push(domainRule);
          }
        }
      }
      if (domains.length) rules.push({ ...rule, domain: [...new Set(domains)] });
    }
    rules.push({
      type: 'field',
      domain: whitelist.map((d) => `domain:${d}`),
      outboundTag: splitRouting.defaultOutboundTag,
    });
  }

  // 2. Collect blocked domain rules based on active shields
  const blockedDomains: string[] = [];

  if (config.blockYoutubeAds) {
    for (const d of YOUTUBE_AD_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }

  if (config.blockAds) {
    blockedDomains.push('geosite:category-ads-all');
    for (const d of AD_NETWORK_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }

  if (config.blockTrackers) {
    for (const d of TRACKER_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }

  if (config.blockMalware) {
    for (const d of MALWARE_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }

  for (const custom of config.customBlockedDomains || []) {
    const clean = custom.trim().toLowerCase();
    if (clean) blockedDomains.push(`domain:${clean}`);
  }

  if (blockedDomains.length > 0) {
    rules.push({
      type: 'field',
      domain: Array.from(new Set(blockedDomains)),
      outboundTag: 'adblock',
    });
  }

  return rules;
}

/**
 * Classifies a blocked hostname into its shield category and estimates payload bytes & handshake latency saved.
 */
export function classifyBlockedDomain(
  rawDomain: string,
  config?: AdBlockConfig
): { category: AdBlockCategory; savedBytes: number; savedMs: number } {
  const host = rawDomain.toLowerCase().replace(/^\.+|\.+$/g, '');

  if (
    config?.customBlockedDomains?.some(
      (c) => host === c.toLowerCase() || host.endsWith(`.${c.toLowerCase()}`)
    )
  ) {
    return { category: 'custom', savedBytes: 24_576, savedMs: 55 };
  }

  if (
    YOUTUBE_AD_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ||
    host.includes('youtube') ||
    host.includes('googlesyndication') ||
    host.includes('doubleclick') ||
    host.includes('googleadservices') ||
    host.includes('2mdn.net') ||
    host.includes('moatads') ||
    host.includes('innovid')
  ) {
    return { category: 'youtube_ads', savedBytes: 78_848, savedMs: 85 };
  }

  if (
    MALWARE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ||
    host.includes('miner') ||
    host.includes('coinhive') ||
    host.includes('cryptoloot')
  ) {
    return { category: 'malware', savedBytes: 19_456, savedMs: 60 };
  }

  if (
    TRACKER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ||
    host.includes('analytics') ||
    host.includes('telemetry') ||
    host.includes('tracker') ||
    host.includes('metric') ||
    host.includes('pixel') ||
    host.includes('beacon') ||
    host.includes('scorecardresearch') ||
    host.includes('hotjar') ||
    host.includes('mixpanel') ||
    host.includes('segment')
  ) {
    return { category: 'trackers', savedBytes: 12_288, savedMs: 48 };
  }

  return { category: 'ad_networks', savedBytes: 34_816, savedMs: 65 };
}

/**
 * Evaluates whether a given domain is blocked by the current AdBlockConfig, and returns the matching rule/category.
 */
export function evaluateDomainShield(
  rawDomain: string,
  config: AdBlockConfig
): {
  blocked: boolean;
  reason: string;
  category?: AdBlockCategory;
} {
  const host = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\.+|\.+$/g, '');

  if (!host) return { blocked: false, reason: 'Empty hostname' };
  if (!config.enabled) return { blocked: false, reason: 'Master Shield is currently paused' };

  const matchesList = (list: string[]) =>
    list.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));

  if (matchesList(config.whitelistedDomains || [])) {
    return { blocked: false, reason: 'Explicitly allowed by your Whitelist' };
  }
  if (matchesList(config.customBlockedDomains || [])) {
    return { blocked: true, reason: 'Matched your Custom Blocklist rule', category: 'custom' };
  }
  if (config.blockYoutubeAds && matchesList(YOUTUBE_AD_DOMAINS)) {
    return { blocked: true, reason: 'Blocked by YouTube & Video Ad Shield', category: 'youtube_ads' };
  }
  if (config.blockMalware && matchesList(MALWARE_DOMAINS)) {
    return { blocked: true, reason: 'Blocked by Malware & Cryptominer Shield', category: 'malware' };
  }
  if (config.blockTrackers && matchesList(TRACKER_DOMAINS)) {
    return { blocked: true, reason: 'Blocked by Cross-Site Tracker Shield', category: 'trackers' };
  }
  if (
    config.blockAds &&
    (matchesList(AD_NETWORK_DOMAINS) ||
      host.startsWith('ad.') ||
      host.startsWith('ads.') ||
      host.includes('doubleclick') ||
      host.includes('googlesyndication') ||
      host.includes('googleadservices') ||
      host.includes('adserver') ||
      host.includes('adservice'))
  ) {
    return { blocked: true, reason: 'Blocked by Global Ad Network & Geosite Shield', category: 'ad_networks' };
  }

  return { blocked: false, reason: 'Clean domain — allowed through tunnel' };
}

/**
 * Records a single blocked request into persistent AdBlockState.
 */
export function recordBlockedDomain(
  state: AdBlockState,
  rawDomain: string,
  now = Date.now()
): void {
  const domain = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^\/\/|^tcp:|^udp:/, '')
    .replace(/:\d+$/, '')
    .replace(/^\.+|\.+$/g, '');

  if (!domain || domain === '127.0.0.1' || domain === 'localhost') return;

  const { category, savedBytes, savedMs } = classifyBlockedDomain(domain, state.config);

  state.totalBlocked += 1;
  state.savedBytes += savedBytes;
  state.savedMs += savedMs;

  if (!state.byCategory[category]) {
    state.byCategory[category] = { blocked: 0, savedBytes: 0 };
  }
  state.byCategory[category].blocked += 1;
  state.byCategory[category].savedBytes += savedBytes;

  // Update 24h hourly bucket
  const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
  let bucket = state.hourly.find((b) => b.timestamp === currentHour);
  if (!bucket) {
    state.hourly = ensureAdBlockState(state).hourly;
    bucket = state.hourly[state.hourly.length - 1];
  }
  if (bucket) {
    bucket.blocked += 1;
    bucket.savedBytes += savedBytes;
  }

  // Update topDomains
  const existing = state.topDomains[domain];
  if (existing) {
    existing.count += 1;
    existing.savedBytes += savedBytes;
    existing.lastBlockedAt = now;
  } else {
    state.topDomains[domain] = {
      domain,
      category,
      count: 1,
      savedBytes,
      lastBlockedAt: now,
    };
    // Cap topDomains dictionary to top 60 domains
    const keys = Object.keys(state.topDomains);
    if (keys.length > 60) {
      const sorted = Object.values(state.topDomains).sort((a, b) => b.count - a.count);
      state.topDomains = Object.fromEntries(sorted.slice(0, 50).map((d) => [d.domain, d]));
    }
  }

  // Prepend to recentBlocked stream (keep last 50)
  state.recentBlocked.unshift({
    id: crypto.randomUUID(),
    timestamp: now,
    domain,
    category,
    savedBytes,
  });
  if (state.recentBlocked.length > 50) {
    state.recentBlocked.length = 50;
  }
}

/**
 * Incrementally tails Xray's access.log to capture every request routed to `[... -> adblock]`.
 */
export class AdBlockLogWatcher {
  private lastOffset = 0;

  public reset(): void {
    this.lastOffset = 0;
  }

  public poll(accessLogPath: string, state: AdBlockState): number {
    if (!state.config.enabled || !fs.existsSync(accessLogPath)) return 0;

    try {
      const stat = fs.statSync(accessLogPath);
      if (stat.size < this.lastOffset) {
        this.lastOffset = 0;
      }
      if (stat.size === this.lastOffset) return 0;

      const fd = fs.openSync(accessLogPath, 'r');
      const len = stat.size - this.lastOffset;
      const buf = Buffer.alloc(Math.min(len, 256 * 1024));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, this.lastOffset);
      fs.closeSync(fd);

      this.lastOffset += bytesRead;

      // Rotate/truncate access log if it grows > 512 KB so disk usage stays tiny
      if (this.lastOffset > 512 * 1024) {
        try {
          fs.truncateSync(accessLogPath, 0);
          this.lastOffset = 0;
        } catch {
          // ignore
        }
      }

      const text = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = text.split(/\r?\n/);
      let newlyBlocked = 0;

      for (const line of lines) {
        if (!line.includes('-> adblock]')) continue;
        // Format: 2026/10/31 20:55:46.375432 from 127.0.0.1:57444 accepted //ads.youtube.com:443 [http-in -> adblock]
        // or: accepted tcp:googleads.g.doubleclick.net:443 [socks-in -> adblock]
        const match = line.match(/accepted\s+(?:tcp:|udp:|\/\/)?([^\s/:]+)(?::\d+)?\s+\[[^\]]*->\s*adblock\]/i);
        if (match && match[1]) {
          recordBlockedDomain(state, match[1]);
          newlyBlocked++;
        }
      }

      return newlyBlocked;
    } catch {
      return 0;
    }
  }
}
