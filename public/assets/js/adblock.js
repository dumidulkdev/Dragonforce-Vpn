import { icon } from './icons.js';
import { escapeHtml, formatBytes } from './ui.js';

const CATEGORY_META = {
  youtube_ads: {
    label: 'YouTube & Video Ads',
    short: 'YouTube Ad',
    color: '#00A896',
    bg: 'rgba(0, 168, 150, 0.1)',
  },
  ad_networks: {
    label: 'Ad Networks & Popups',
    short: 'Ad Network',
    color: '#0F2942',
    bg: 'rgba(15, 41, 66, 0.08)',
  },
  trackers: {
    label: 'Trackers & Telemetry',
    short: 'Tracker',
    color: '#2563EB',
    bg: 'rgba(37, 99, 235, 0.09)',
  },
  malware: {
    label: 'Malware & Miners',
    short: 'Malware',
    color: '#D9822B',
    bg: 'rgba(217, 130, 43, 0.11)',
  },
  custom: {
    label: 'Custom Rule',
    short: 'Custom',
    color: '#64748B',
    bg: 'rgba(100, 116, 139, 0.12)',
  },
};

const SHIELD_LAYERS = [
  {
    key: 'blockYoutubeAds',
    title: 'YouTube & Video Ad Shield',
    sub: 'Blocks ads.youtube.com, DoubleClick video auctions, googlesyndication pre-roll pings & 2mdn servers.',
    rules: '1,420 rules',
  },
  {
    key: 'blockAds',
    title: 'Global Ad Networks & Popups',
    sub: 'Xray geosite:category-ads-all database covering Taboola, Outbrain, Criteo, PopAds & banner exchanges.',
    rules: '140,200 rules',
  },
  {
    key: 'blockTrackers',
    title: 'Cross-Site Trackers & Telemetry',
    sub: 'Stops ScorecardResearch, Hotjar, Mixpanel, Segment, Clarity & behavioral fingerprinting scripts.',
    rules: '980 rules',
  },
  {
    key: 'blockMalware',
    title: 'Malware, Phishing & Cryptominers',
    sub: 'Blocks browser cryptojacking pools (CoinHive, CryptoLoot) and known malicious hosts.',
    rules: '460 rules',
  },
  {
    key: 'adguardDns',
    title: 'AdGuard Upstream DNS Sinkhole',
    sub: 'Routes tunnel DNS queries through AdGuard DNS (94.140.14.14) for DNS-level ad resolution blocking.',
    rules: 'DNS Layer',
  },
];

function formatTimeSaved(ms) {
  if (!ms || ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function formatAgo(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderDonutSvg(slices, centerTop, centerSub, size = 122) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 3;
  const rInner = Math.round(rOuter * 0.62);

  const positive = slices.filter((s) => s.value > 0);
  const total = positive.reduce((a, b) => a + b.value, 0);

  let paths = '';
  if (total <= 0) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="var(--surface-3)" />`;
  } else if (positive.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${positive[0].color}"><title>${escapeHtml(positive[0].label)}</title></circle>`;
  } else {
    let angle = -Math.PI / 2;
    for (const s of positive) {
      const frac = Math.max(0.015, s.value / total);
      const sweep = Math.min(Math.PI * 1.999, frac * Math.PI * 2);
      const end = angle + sweep;
      const x1 = cx + rOuter * Math.cos(angle);
      const y1 = cy + rOuter * Math.sin(angle);
      const x2 = cx + rOuter * Math.cos(end);
      const y2 = cy + rOuter * Math.sin(end);
      const largeArc = sweep > Math.PI ? 1 : 0;
      paths += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${s.color}" stroke="var(--surface)" stroke-width="2" stroke-linejoin="round"><title>${escapeHtml(s.label)}</title></path>`;
      angle = end;
    }
  }

  return `<svg class="sub-pie-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(centerTop)} ${escapeHtml(centerSub)}">
    ${paths}
    <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="var(--surface)" />
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700" font-family="Poppins, sans-serif">${escapeHtml(centerTop)}</text>
    <text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="var(--text-3)" font-size="8.5" font-weight="600" letter-spacing="0.06em" font-family="Poppins, sans-serif">${escapeHtml(centerSub)}</text>
  </svg>`;
}

function render24hChart(hourly = []) {
  const w = 640;
  const h = 190;
  const padL = 34;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const buckets = hourly.length === 24
    ? hourly
    : Array.from({ length: 24 }, (_, i) => {
        const ts = Math.floor(Date.now() / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000;
        return hourly[i] || { timestamp: ts, blocked: 0, savedBytes: 0 };
      });

  const maxVal = Math.max(4, ...buckets.map((b) => b.blocked || 0));
  const stepX = plotW / buckets.length;
  const barW = Math.max(8, Math.min(16, stepX * 0.54));

  const gridLines = [0, 0.5, 1].map((pct) => {
    const y = padT + plotH * (1 - pct);
    const val = Math.round(maxVal * pct);
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="${pct === 0 ? 'none' : '3 3'}" />
      <text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="var(--text-3)" font-size="10" font-family="Poppins, sans-serif">${val}</text>
    `;
  });

  const bars = buckets.map((b, idx) => {
    const cx = padL + idx * stepX + stepX / 2;
    const val = b.blocked || 0;
    const bh = val > 0 ? Math.max(4, (val / maxVal) * plotH) : 2;
    const y = padT + plotH - bh;
    const hourStr = new Date(b.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const showLabel = idx % 4 === 0 || idx === 23;

    return `
      <g>
        <rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3.5" fill="${val > 0 ? '#00A896' : 'var(--surface-3)'}">
          <title>${hourStr} — ${val} blocked (${formatBytes(b.savedBytes || 0)} saved)</title>
        </rect>
        ${
          showLabel
            ? `<text x="${cx.toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="var(--text-3)" font-size="10" font-family="Poppins, sans-serif">${idx === 23 ? 'Now' : hourStr}</text>`
            : ''
        }
      </g>
    `;
  });

  return `<svg class="ab-hourly-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="24-hour blocked activity">
    ${gridLines.join('')}
    ${bars.join('')}
  </svg>`;
}

/**
 * Custom metallic/glass SVG emblem for the centered Shield Core button.
 */
function shieldCoreEmblemSvg(enabled) {
  return `<svg class="ab-core-svg" width="52" height="52" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M24 5L39 10.5V22.8C39 32.8 32.4 40.3 24 43.5C15.6 40.3 9 32.8 9 22.8V10.5L24 5Z" fill="${enabled ? 'rgba(255,255,255,0.16)' : 'rgba(15,29,40,0.04)'}" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
    ${
      enabled
        ? '<path d="M18.2 24.4L22.3 28.5L30.2 19.8" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'
        : '<path d="M24 17V25" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><circle cx="24" cy="30.5" r="1.6" fill="currentColor"/>'
    }
  </svg>`;
}

export function renderShield(root, store) {
  const ab = store.data.adblock || {
    config: {
      enabled: true,
      blockYoutubeAds: true,
      blockAds: true,
      blockTrackers: true,
      blockMalware: true,
      adguardDns: true,
      customBlockedDomains: [],
      whitelistedDomains: [],
    },
    totalBlocked: 0,
    savedBytes: 0,
    savedMs: 0,
    byCategory: {},
    hourly: [],
    topDomains: {},
    recentBlocked: [],
  };

  const cfg = ab.config || {};
  const enabled = Boolean(cfg.enabled);
  const workspace = store.adblockWorkspace || 'overview';
  const tab = store.adblockTab || 'top';
  const searchQuery = (store.adblockSearch || '').trim().toLowerCase();
  const checkResult = store.adblockCheckResult || null;

  const hourly = ab.hourly || [];
  const blocked24h = hourly.reduce((acc, b) => acc + (b.blocked || 0), 0);
  const saved24h = hourly.reduce((acc, b) => acc + (b.savedBytes || 0), 0);

  const byCat = ab.byCategory || {};
  const ytCount = byCat.youtube_ads?.blocked || 0;
  const adCount = byCat.ad_networks?.blocked || 0;
  const trkCount = byCat.trackers?.blocked || 0;
  const malCount = byCat.malware?.blocked || 0;
  const custCount = byCat.custom?.blocked || 0;

  const activeLayersCount = SHIELD_LAYERS.filter((l) => cfg[l.key]).length;
  const hasFilters = activeLayersCount > 0 || cfg.customBlockedDomains?.length > 0;
  const active = enabled && hasFilters && store.status?.connected && !store.status?.connecting;

  const topDomainsArr = Object.values(ab.topDomains || {})
    .filter((d) => !searchQuery || d.domain.toLowerCase().includes(searchQuery))
    .sort((a, b) => b.count - a.count);

  const maxDomainHits = Math.max(1, topDomainsArr[0]?.count || 1);

  const recentArr = (ab.recentBlocked || []).filter(
    (e) => !searchQuery || e.domain.toLowerCase().includes(searchQuery)
  );

  // =========================================================================
  // WORKSPACE 1: SHIELD CORE (Centered Tactile Shield + Clean Telemetry + Quick Controls)
  // =========================================================================
  const overviewHtml = `
    <!-- Centered Shield Command Stage -->
    <section class="panel ab-stage-panel" data-shield="${active ? 'on' : 'off'}">
      <div class="ab-stage-center">
        <div class="ab-core-orbit-wrap ${store.adblockJustToggled ? 'is-bursting' : ''}">
          <span class="ab-sonar-ring r1" aria-hidden="true"></span>
          <span class="ab-sonar-ring r2" aria-hidden="true"></span>
          <span class="ab-orbit-track" aria-hidden="true"></span>

          <button
            type="button"
            class="ab-core-btn ${active ? 'is-on' : 'is-off'}"
            data-act="ab-toggle"
            aria-pressed="${enabled}"
            title="${enabled ? 'Click to pause Privacy & Ad Shield' : 'Click to start Privacy & Ad Shield'}"
          >
            ${shieldCoreEmblemSvg(active)}
            <span class="ab-core-btn-label">${active ? 'ACTIVE' : enabled ? 'READY' : 'START'}</span>
          </button>
        </div>

        <div class="ab-stage-status">
          <div class="ab-stage-badge ${active ? 'is-on' : 'is-off'}">
            <span class="status-dot ${active ? 'is-on' : ''}"></span>
            <span>${active ? `Protection Active · ${activeLayersCount ? `${activeLayersCount}/5 Shields Armed` : 'Custom Rules Enabled'}` : enabled ? 'Protection Inactive · Connect VPN & Enable Filters' : 'Protection Paused · Tap Shield to Start'}</span>
          </div>
          <h2>${active ? 'VPN traffic is filtered against ads & trackers' : 'Ad & Tracker filtering is currently inactive'}</h2>
          <p>
            ${
              active
                ? `Configured filters apply to traffic routed through Xray-core${cfg.adguardDns ? ' with AdGuard DNS (94.140.14.14)' : ''}. Live verification checks Xray logs for blocked test connections.`
                : 'Your filter preferences are saved. Protection requires an active VPN connection and at least one enabled filter.'
            }
          </p>

          <div class="ab-stage-actions">
            <button type="button" class="btn btn-sm" data-act="ab-test" ${!active ? 'disabled' : ''}>
              ${icon('zap', 14)}<span>Run Live Verification Test</span>
            </button>
            <button type="button" class="btn btn-sm" data-act="ab-workspace" data-ws="activity">
              ${icon('chart', 14)}<span>View Blocked Log &amp; Charts (${(ab.totalBlocked || 0).toLocaleString()})</span>
            </button>
            <button type="button" class="btn btn-sm" data-act="ab-workspace" data-ws="settings">
              ${icon('settings', 14)}<span>Custom Rules &amp; Whitelist</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Integrated 3-Column Brave-Style Telemetry Bar -->
      <div class="ab-stage-metrics">
        <div class="ab-stage-metric">
          <span class="ab-stage-metric-label">Trackers &amp; Ads Blocked</span>
          <strong class="ab-stage-metric-val num">${(ab.totalBlocked || 0).toLocaleString()}</strong>
          <span class="ab-stage-metric-sub num">
            ${blocked24h > 0 ? `<b class="tone-good">+${blocked24h.toLocaleString()} today</b> · ` : ''}${ytCount} YouTube · ${adCount + trkCount} Ads/Trackers
          </span>
        </div>

        <div class="ab-stage-metric">
          <span class="ab-stage-metric-label">Est. Bandwidth Saved</span>
          <strong class="ab-stage-metric-val num is-teal">${formatBytes(ab.savedBytes || 0)}</strong>
          <span class="ab-stage-metric-sub num">${formatBytes(saved24h)} saved in last 24h</span>
        </div>

        <div class="ab-stage-metric">
          <span class="ab-stage-metric-label">Est. Load Time Saved</span>
          <strong class="ab-stage-metric-val num">${formatTimeSaved(ab.savedMs || 0)}</strong>
          <span class="ab-stage-metric-sub">~65 ms faster per blocked ad request</span>
        </div>
      </div>
    </section>

    <!-- Clean 2-Column Overview Lower Grid: Protection Switches + Recent Intercepts -->
    <div class="ab-overview-grid">
      <section class="panel section">
        <div class="ab-sec-head">
          <div>
            <div class="section-title">Protection Engines</div>
            <div class="section-desc">Toggle individual filter modules in real time.</div>
          </div>
          <span class="tag is-accent">${activeLayersCount} of 5 enabled</span>
        </div>

        <div class="ab-clean-settings">
          ${SHIELD_LAYERS.map((l) => {
            const on = Boolean(cfg[l.key]);
            return `
            <div class="setting ab-setting-row">
              <div class="setting-text">
                <strong>${l.title} <span class="ab-rule-count-pill">${l.rules}</span></strong>
                <span>${l.sub}</span>
              </div>
              <button
                type="button"
                class="switch"
                role="switch"
                aria-checked="${on}"
                aria-label="${l.title}"
                data-act="ab-layer"
                data-key="${l.key}"
              ></button>
            </div>`;
          }).join('')}
        </div>
      </section>

      <div class="ab-overview-right">
        <!-- Configured Domain Rule Preview -->
        <section class="panel section">
          <div class="section-title">Domain Inspector (Simulation)</div>
          <div class="section-desc">Preview whether your configured Shield rules would block a domain. Use Live Verification to check actual Xray traffic.</div>

          <div class="row" style="margin-top:12px">
            <label class="field">
              ${icon('search', 15)}
              <input
                data-ref="abCheckInput"
                value="${escapeHtml(store.adblockCheckInput || 'ads.youtube.com')}"
                placeholder="Enter domain (e.g. ads.youtube.com)"
                aria-label="Domain to preview"
              />
            </label>
            <button type="button" class="btn btn-primary" data-act="ab-check-domain">Preview</button>
          </div>

          <div class="ab-preset-chips">
            <span>Try:</span>
            ${['ads.youtube.com', 'googleads.g.doubleclick.net', 'scorecardresearch.com', 'coinhive.com', 'youtube.com']
              .map(
                (host) =>
                  `<button type="button" class="ab-preset-chip mono" data-act="ab-preset-domain" data-domain="${host}">${host}</button>`
              )
              .join('')}
          </div>

          ${
            checkResult
              ? `<div class="ab-check-verdict ${checkResult.blocked ? 'is-blocked' : 'is-allowed'}">
                  <span class="ab-verdict-icon">${icon(checkResult.blocked ? 'shieldCheck' : 'check', 16)}</span>
                  <div>
                    <strong>${escapeHtml(checkResult.domain)} — SIMULATION: ${checkResult.blocked ? 'WOULD BLOCK' : 'WOULD ALLOW'}</strong>
                    <span>${escapeHtml(checkResult.reason)}</span>
                  </div>
                </div>`
              : ''
          }
        </section>

        <!-- Recent Blocked Sites Preview -->
        <section class="panel section">
          <div class="ab-sec-head">
            <div>
              <div class="section-title">Top Intercepted Domains</div>
              <div class="section-desc">Domains blocked most frequently by Xray-core</div>
            </div>
            <button type="button" class="link-btn" data-act="ab-workspace" data-ws="activity">View all →</button>
          </div>

          <div class="ab-mini-domain-list">
            ${
              topDomainsArr.slice(0, 5).length
                ? topDomainsArr
                    .slice(0, 5)
                    .map((d) => {
                      const meta = CATEGORY_META[d.category] || CATEGORY_META.ad_networks;
                      return `
                      <div class="ab-mini-domain-row">
                        <div class="ab-mini-domain-left">
                          <span class="ab-dot" style="background:${meta.color}"></span>
                          <strong class="mono">${escapeHtml(d.domain)}</strong>
                          <span class="ab-cat-badge" style="background:${meta.bg};color:${meta.color}">${meta.short}</span>
                        </div>
                        <span class="ab-mini-domain-right num">${d.count}× · ${formatBytes(d.savedBytes)}</span>
                      </div>`;
                    })
                    .join('')
                : `<div class="ab-empty-inline">No domains blocked yet — connect the VPN, then run <strong>Live Verification</strong> to test.</div>`
            }
          </div>
        </section>
      </div>
    </div>
  `;

  // =========================================================================
  // WORKSPACE 2: ANALYTICS & BLOCKED SITES LOG
  // =========================================================================
  const pieSlices = [
    { value: ytCount, color: CATEGORY_META.youtube_ads.color, label: `YouTube Ads: ${ytCount}` },
    { value: adCount, color: CATEGORY_META.ad_networks.color, label: `Ad Networks: ${adCount}` },
    { value: trkCount, color: CATEGORY_META.trackers.color, label: `Trackers: ${trkCount}` },
    { value: malCount, color: CATEGORY_META.malware.color, label: `Malware: ${malCount}` },
    { value: custCount, color: CATEGORY_META.custom.color, label: `Custom: ${custCount}` },
  ];

  const activityHtml = `
    <div class="ab-charts-grid">
      <section class="panel ab-chart-panel">
        <div class="ab-panel-head">
          <div>
            <div class="section-title">24-Hour Interception Timeline</div>
            <div class="section-desc">Hourly count of ad, tracker, and YouTube ad connections dropped before reaching your browser.</div>
          </div>
          <div class="row">
            <button type="button" class="btn btn-sm" data-act="ab-test" ${!active ? 'disabled' : ''}>${icon('zap', 14)}Run Live Verification</button>
            <button type="button" class="btn btn-sm" data-act="ab-reset">${icon('reset', 14)}Reset Stats</button>
          </div>
        </div>
        <div class="ab-hourly-wrap">
          ${render24hChart(hourly)}
        </div>
      </section>

      <section class="panel ab-pie-panel">
        <div class="section-title">Category Breakdown</div>
        <div class="section-desc">Share of blocked requests by filter engine</div>
        <div class="ab-pie-body" style="margin-top:12px">
          <div class="ab-pie-center">
            ${renderDonutSvg(pieSlices, (ab.totalBlocked || 0).toLocaleString(), 'BLOCKED', 120)}
          </div>
          <div class="ab-pie-legend num">
            ${Object.entries(CATEGORY_META)
              .map(([key, meta]) => {
                const c = byCat[key] || { blocked: 0, savedBytes: 0 };
                return `<div class="ab-pie-row">
                  <span class="ab-pie-label"><i style="background:${meta.color}"></i>${meta.label}</span>
                  <strong>${c.blocked.toLocaleString()} <small>(${formatBytes(c.savedBytes)})</small></strong>
                </div>`;
              })
              .join('')}
          </div>
        </div>
      </section>
    </div>

    <section class="panel ab-domains-panel">
      <div class="ab-domains-toolbar">
        <div class="segmented" role="group" aria-label="Blocked view mode">
          <button type="button" data-act="ab-tab" data-tab="top" aria-pressed="${tab === 'top'}">Top Blocked Domains (${Object.keys(ab.topDomains || {}).length})</button>
          <button type="button" data-act="ab-tab" data-tab="live" aria-pressed="${tab === 'live'}">Live Intercept Stream (${(ab.recentBlocked || []).length})</button>
        </div>
        <label class="field field-muted ab-search-field">
          ${icon('search', 14)}
          <input
            type="search"
            data-ref="abSearch"
            value="${escapeHtml(store.adblockSearch || '')}"
            placeholder="Search blocked domains…"
            aria-label="Search blocked domains"
          />
        </label>
      </div>

      <div class="ab-domains-list">
        ${
          tab === 'top'
            ? topDomainsArr.length
              ? topDomainsArr
                  .slice(0, 25)
                  .map((d) => {
                    const meta = CATEGORY_META[d.category] || CATEGORY_META.ad_networks;
                    const pct = Math.max(5, Math.round((d.count / maxDomainHits) * 100));
                    return `
                    <div class="ab-domain-row">
                      <div class="ab-domain-main">
                        <div class="ab-domain-title-line">
                          <strong class="mono">${escapeHtml(d.domain)}</strong>
                          <span class="ab-cat-badge" style="background:${meta.bg};color:${meta.color}">${meta.short}</span>
                        </div>
                        <div class="ab-domain-bar"><i style="width:${pct}%;background:${meta.color}"></i></div>
                      </div>
                      <div class="ab-domain-stats num">
                        <strong>${d.count.toLocaleString()} blocked</strong>
                        <span>${formatBytes(d.savedBytes)} saved</span>
                      </div>
                      <button
                        type="button"
                        class="btn btn-sm ab-allow-btn"
                        data-act="ab-quick-whitelist"
                        data-domain="${escapeHtml(d.domain)}"
                        title="Add domain to Whitelist"
                      >
                        Allow
                      </button>
                    </div>`;
                  })
                  .join('')
              : `<div class="empty"><span class="empty-icon">${icon('shieldCheck', 20)}</span><strong>No blocked domains recorded yet</strong><p>Connect the VPN and browse the web or run Live Verification to test.</p></div>`
            : recentArr.length
              ? recentArr
                  .slice(0, 30)
                  .map((ev) => {
                    const meta = CATEGORY_META[ev.category] || CATEGORY_META.ad_networks;
                    return `
                    <div class="ab-domain-row is-feed">
                      <div class="ab-domain-main">
                        <div class="ab-domain-title-line">
                          <strong class="mono">${escapeHtml(ev.domain)}</strong>
                          <span class="ab-cat-badge" style="background:${meta.bg};color:${meta.color}">${meta.short}</span>
                        </div>
                        <span class="ab-feed-time">${new Date(ev.timestamp).toLocaleTimeString()} · ${formatAgo(ev.timestamp)}</span>
                      </div>
                      <div class="ab-domain-stats num">
                        <strong>Dropped</strong>
                        <span>+${formatBytes(ev.savedBytes)} saved</span>
                      </div>
                    </div>`;
                  })
                  .join('')
              : `<div class="empty"><span class="empty-icon">${icon('clock', 20)}</span><strong>No recent intercepts</strong><p>Blocked ad and tracker connections appear here in real time.</p></div>`
        }
      </div>
    </section>
  `;

  // =========================================================================
  // WORKSPACE 3: FILTER RULES, DNS & CUSTOM LISTS
  // =========================================================================
  const settingsHtml = `
    <div class="ab-settings-grid">
      <section class="panel section">
        <div class="section-title">Custom Domain Blocklist</div>
        <div class="section-desc">Domains and subdomains listed here are blocked while Shield and the VPN connection are active.</div>
        <div class="row" style="margin-top:12px">
          <label class="field">
            ${icon('shield', 15)}
            <input data-ref="abBlockInput" placeholder="e.g. ads.example.com" aria-label="Custom domain to block" />
          </label>
          <button type="button" class="btn btn-primary" data-act="ab-add-block">${icon('plus', 15)}Block Domain</button>
        </div>
        <div class="ab-chip-list">
          ${
            (cfg.customBlockedDomains || []).length
              ? cfg.customBlockedDomains
                  .map(
                    (d) => `<span class="ab-rule-chip is-block mono">
                      ${escapeHtml(d)}
                      <button type="button" data-act="ab-rm-block" data-domain="${escapeHtml(d)}" aria-label="Remove">${icon('x', 12)}</button>
                    </span>`
                  )
                  .join('')
              : '<span class="tone-none" style="font-size:12px">No custom blocked domains configured.</span>'
          }
        </div>
      </section>

      <section class="panel section">
        <div class="section-title">Whitelisted Domains (Bypass Shield)</div>
        <div class="section-desc">Domains listed here bypass Ad Shield and follow your routing settings, including Split Tunneling.</div>
        <div class="row" style="margin-top:12px">
          <label class="field">
            ${icon('check', 15)}
            <input data-ref="abWhiteInput" placeholder="e.g. partner.example.com" aria-label="Domain to whitelist" />
          </label>
          <button type="button" class="btn" data-act="ab-add-white">${icon('plus', 15)}Allow Domain</button>
        </div>
        <div class="ab-chip-list">
          ${
            (cfg.whitelistedDomains || []).length
              ? cfg.whitelistedDomains
                  .map(
                    (d) => `<span class="ab-rule-chip is-white mono">
                      ${escapeHtml(d)}
                      <button type="button" data-act="ab-rm-white" data-domain="${escapeHtml(d)}" aria-label="Remove">${icon('x', 12)}</button>
                    </span>`
                  )
                  .join('')
              : '<span class="tone-none" style="font-size:12px">No whitelisted domains configured.</span>'
          }
        </div>
      </section>
    </div>

    <section class="panel section" style="margin-top:16px">
      <div class="section-title">Filter Engine Configuration</div>
      <div class="section-desc">Control which categories are intercepted inside Xray-core and upstream DNS.</div>
      <div class="ab-clean-settings" style="margin-top:8px">
        ${SHIELD_LAYERS.map((l) => {
          const on = Boolean(cfg[l.key]);
          return `
          <div class="setting ab-setting-row">
            <div class="setting-text">
              <strong>${l.title} <span class="ab-rule-count-pill">${l.rules}</span></strong>
              <span>${l.sub}</span>
            </div>
            <button
              type="button"
              class="switch"
              role="switch"
              aria-checked="${on}"
              aria-label="${l.title}"
              data-act="ab-layer"
              data-key="${l.key}"
            ></button>
          </div>`;
        }).join('')}
      </div>
    </section>
  `;

  root.innerHTML = `<div class="page ab-page">
    <header class="page-head ab-top-bar">
      <div>
        <h1>Privacy &amp; Ad Shield</h1>
        <p>Network-level YouTube ad, tracker, and malware blocker powered by Xray-core Geosite &amp; AdGuard DNS.</p>
      </div>
      <div class="segmented ab-ws-switcher" role="tablist" aria-label="Shield workspace">
        <button type="button" role="tab" data-act="ab-workspace" data-ws="overview" aria-pressed="${workspace === 'overview'}">
          ${icon('shieldCheck', 15)}<span>Shield Core</span>
        </button>
        <button type="button" role="tab" data-act="ab-workspace" data-ws="activity" aria-pressed="${workspace === 'activity'}">
          ${icon('chart', 15)}<span>Analytics &amp; Blocked (${(ab.totalBlocked || 0).toLocaleString()})</span>
        </button>
        <button type="button" role="tab" data-act="ab-workspace" data-ws="settings" aria-pressed="${workspace === 'settings'}">
          ${icon('settings', 15)}<span>Rules &amp; DNS</span>
        </button>
      </div>
    </header>

    ${workspace === 'overview' ? overviewHtml : workspace === 'activity' ? activityHtml : settingsHtml}
  </div>`;
}
