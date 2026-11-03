import { icon } from './icons.js';
import { escapeHtml } from './ui.js';

const PRESET_CATALOG = [
  {
    id: 'sri_lanka_local',
    title: 'Sri Lanka (.lk) & Local Banking',
    desc: 'All .lk domains, Commercial Bank, Sampath, HNB, BOC, Gov.lk, Dialog, SLT & Daraz',
    icon: 'globe',
    samples: ['.lk', 'combank.lk', 'sampath.lk', 'dialog.lk'],
    domains: [
      'lk', 'combank.lk', 'sampath.lk', 'hnb.net', 'hnb.lk', 'boc.lk',
      'peoplesbank.lk', 'ndbbank.com', 'seylan.lk', 'frimi.lk', 'dialog.lk',
      'slt.lk', 'mobitel.lk', 'daraz.lk', 'ikman.lk', 'pickme.lk',
    ],
    count: 25,
  },
  {
    id: 'gaming',
    title: 'Gaming & Game Launchers',
    desc: 'Steam, Epic Games, Riot / Valorant, Battle.net, EA, Xbox Live, PSN & Roblox',
    icon: 'zap',
    samples: ['steampowered.com', 'riotgames.com', 'epicgames.com'],
    domains: [
      'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'epicgames.com',
      'riotgames.com', 'leagueoflegends.com', 'playvalorant.com', 'battle.net',
      'ea.com', 'xboxlive.com', 'playstation.com', 'roblox.com',
    ],
    count: 17,
  },
  {
    id: 'streaming',
    title: 'Video & Music Streaming',
    desc: 'Netflix, Prime Video, Disney+, Twitch, Spotify & Apple Music',
    icon: 'monitor',
    samples: ['netflix.com', 'spotify.com', 'twitch.tv'],
    domains: [
      'netflix.com', 'nflxvideo.net', 'primevideo.com', 'disneyplus.com',
      'twitch.tv', 'ttvnw.net', 'spotify.com', 'scdn.co',
    ],
    count: 13,
  },
  {
    id: 'messaging',
    title: 'Voice, Video & Messaging Apps',
    desc: 'Discord, WhatsApp, Telegram, Zoom, Microsoft Teams & Google Meet',
    icon: 'smartphone',
    samples: ['discord.com', 'whatsapp.com', 'telegram.org'],
    domains: [
      'discord.com', 'discordapp.com', 'whatsapp.com', 'whatsapp.net',
      'telegram.org', 't.me', 'zoom.us', 'teams.microsoft.com',
    ],
    count: 14,
  },
  {
    id: 'ai_cloud',
    title: 'AI & Developer Platforms',
    desc: 'ChatGPT / OpenAI, Claude, Gemini, GitHub, HuggingFace & Vercel',
    icon: 'terminal',
    samples: ['chatgpt.com', 'claude.ai', 'github.com'],
    domains: [
      'openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com',
      'gemini.google.com', 'github.com', 'huggingface.co', 'vercel.com',
    ],
    count: 12,
  },
  {
    id: 'windows_updates',
    title: 'Windows Update & Delivery CDN',
    desc: 'Microsoft Windows Update, Delivery Optimization & Store payloads',
    icon: 'download',
    samples: ['windowsupdate.com', 'delivery.mp.microsoft.com'],
    domains: [
      'windowsupdate.com', 'update.microsoft.com', 'delivery.mp.microsoft.com',
    ],
    count: 5,
  },
];

const DEFAULT_ANDROID_APPS = [
  { packageName: 'com.whatsapp', name: 'WhatsApp Messenger', isSystem: false },
  { packageName: 'org.telegram.messenger', name: 'Telegram', isSystem: false },
  { packageName: 'com.google.android.youtube', name: 'YouTube', isSystem: false },
  { packageName: 'com.android.chrome', name: 'Google Chrome', isSystem: true },
  { packageName: 'com.instagram.android', name: 'Instagram', isSystem: false },
  { packageName: 'com.netflix.mediaclient', name: 'Netflix', isSystem: false },
  { packageName: 'lk.combank.digital', name: 'ComBank Digital (Sri Lanka)', isSystem: false },
  { packageName: 'lk.sampath.vishwa', name: 'Sampath Vishwa', isSystem: false },
  { packageName: 'lk.dialog.mydialog', name: 'MyDialog (Sri Lanka)', isSystem: false },
  { packageName: 'com.discord', name: 'Discord', isSystem: false },
  { packageName: 'com.valvesoftware.android.steam.community', name: 'Steam Mobile', isSystem: false },
  { packageName: 'com.spotify.music', name: 'Spotify', isSystem: false },
];

function ensureClientSplitTunnel(st) {
  const raw = st || {};
  const presets = raw.presets || {};
  return {
    mode: raw.mode === 'bypass' || raw.mode === 'vpn_only' ? raw.mode : 'off',
    presets: {
      sri_lanka_local: Boolean(presets.sri_lanka_local),
      gaming: Boolean(presets.gaming),
      streaming: Boolean(presets.streaming),
      messaging: Boolean(presets.messaging),
      ai_cloud: Boolean(presets.ai_cloud),
      windows_updates: Boolean(presets.windows_updates),
    },
    customDomains: Array.isArray(raw.customDomains) ? raw.customDomains : [],
    customIps: Array.isArray(raw.customIps) ? raw.customIps : [],
    perAppMode:
      raw.perAppMode === 'bypass_selected' || raw.perAppMode === 'only_selected'
        ? raw.perAppMode
        : 'off',
    selectedApps: Array.isArray(raw.selectedApps) ? raw.selectedApps : [],
  };
}

function previewClientRoute(rawTarget, st, bypassLan = true) {
  const clean = String(rawTarget || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/^\*\./, '')
    .replace(/^\.+/, '');

  if (!clean) return null;

  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(clean) && bypassLan) {
    return {
      target: clean,
      outbound: 'direct',
      routeLabel: 'Direct Local Network (LAN)',
      matchedSource: 'Bypass Local Networks',
      matchedRule: 'Private RFC1918 IP -> direct',
    };
  }

  if (st.mode === 'off') {
    return {
      target: clean,
      outbound: 'proxy',
      routeLabel: 'Encrypted VPN Tunnel',
      matchedSource: 'Global VPN Mode',
      matchedRule: 'outboundTag: "proxy"',
    };
  }

  const matchedOutbound = st.mode === 'bypass' ? 'direct' : 'proxy';
  const matchedLabel =
    matchedOutbound === 'direct' ? 'Direct ISP (Bypasses VPN)' : 'Encrypted VPN Tunnel (VPN-Only)';
  const fallbackOutbound = st.mode === 'bypass' ? 'proxy' : 'direct';
  const fallbackLabel =
    fallbackOutbound === 'proxy' ? 'Encrypted VPN Tunnel (Default)' : 'Direct ISP (Unlisted Traffic)';

  for (const dom of st.customDomains) {
    if (clean === dom || clean.endsWith(`.${dom}`)) {
      return {
        target: clean,
        outbound: matchedOutbound,
        routeLabel: matchedLabel,
        matchedSource: 'Custom Domain Rule',
        matchedRule: `domain:${dom} -> ${matchedOutbound}`,
      };
    }
  }

  for (const ip of st.customIps) {
    if (clean === ip || clean === ip.split('/')[0]) {
      return {
        target: clean,
        outbound: matchedOutbound,
        routeLabel: matchedLabel,
        matchedSource: 'Custom IP / Subnet Rule',
        matchedRule: `ip:${ip} -> ${matchedOutbound}`,
      };
    }
  }

  for (const preset of PRESET_CATALOG) {
    if (!st.presets[preset.id]) continue;
    for (const d of preset.domains) {
      if (clean === d || clean.endsWith(`.${d}`)) {
        return {
          target: clean,
          outbound: matchedOutbound,
          routeLabel: matchedLabel,
          matchedSource: `Group: ${preset.title}`,
          matchedRule: `domain:${d} -> ${matchedOutbound}`,
        };
      }
    }
  }

  return {
    target: clean,
    outbound: fallbackOutbound,
    routeLabel: fallbackLabel,
    matchedSource: st.mode === 'bypass' ? 'Default Catch-All → VPN' : 'Default Catch-All → Direct ISP',
    matchedRule: `outboundTag: "${fallbackOutbound}"`,
  };
}

export function renderSplitTunnel(root, store) {
  const st = ensureClientSplitTunnel(store.data?.splitTunnel);
  const mode = st.mode;

  const enabledPresetCount = PRESET_CATALOG.filter((p) => st.presets[p.id]).length;
  const presetDomainTotal = PRESET_CATALOG.reduce(
    (sum, p) => sum + (st.presets[p.id] ? p.count : 0),
    0
  );
  const customTotal = st.customDomains.length + st.customIps.length;
  const activeRuleCount = presetDomainTotal + customTotal;

  const actionTagLabel =
    mode === 'bypass'
      ? 'DIRECT ISP'
      : mode === 'vpn_only'
      ? 'VPN TUNNEL'
      : 'STANDBY';

  const defaultRouteLabel =
    mode === 'vpn_only' ? 'Direct ISP (Unencrypted)' : 'Encrypted VPN Tunnel';
  const selectedRouteLabel =
    mode === 'bypass'
      ? 'Direct ISP (Bypass VPN)'
      : mode === 'vpn_only'
      ? 'Encrypted VPN Tunnel'
      : 'Encrypted VPN (Split Off)';

  const currentTestTarget = store.splitTestInput || 'combank.lk';
  const testResult =
    store.splitTestResult ||
    previewClientRoute(currentTestTarget, st, store.data?.bypassLan ?? true);

  const perAppMode = st.perAppMode || 'off';
  const selectedApps = st.selectedApps || [];
  const rawApps =
    Array.isArray(store.installedApps) && store.installedApps.length > 0
      ? store.installedApps
      : DEFAULT_ANDROID_APPS;
  const appSearch = (store.splitAppSearch || '').trim().toLowerCase();
  const filteredApps = rawApps.filter(
    (app) =>
      !appSearch ||
      app.name.toLowerCase().includes(appSearch) ||
      app.packageName.toLowerCase().includes(appSearch)
  );

  root.innerHTML = `<div class="page st-page">
    <!-- Page Header -->
    <div class="page-head st-page-head">
      <div class="st-head-copy">
        <div class="st-title-row">
          <h1 class="page-title">Smart Split Tunneling</h1>
          <span class="st-status-pill ${mode !== 'off' ? 'is-active' : ''}">
            <span class="st-status-dot"></span>
            ${
              mode === 'bypass'
                ? `Bypass Active · ${activeRuleCount} endpoints direct`
                : mode === 'vpn_only'
                ? `VPN-Only Active · ${activeRuleCount} endpoints tunneled`
                : 'Global VPN · All traffic encrypted'
            }
          </span>
        </div>
        <p class="page-sub">Route specific websites, local banking, gaming launchers, or IP subnets directly through your ISP while keeping everything else inside the encrypted VPN tunnel.</p>
      </div>
    </div>

    <!-- 1. Top Policy Selector + Live Routing Pipeline -->
    <section class="panel st-hero-panel">
      <div class="st-mode-grid" role="radiogroup" aria-label="Split Tunneling Mode">
        <button type="button" class="st-mode-card ${mode === 'off' ? 'is-active' : ''}" data-act="st-mode" data-mode="off">
          <div class="st-mode-top">
            <span class="st-mode-icon">${icon('shieldCheck', 18)}</span>
            <span class="st-mode-tag">Full Tunnel</span>
            <span class="st-mode-radio"></span>
          </div>
          <div class="st-mode-title">Off · Global VPN</div>
          <div class="st-mode-desc">Every app and website routes through the encrypted VPN server.</div>
        </button>

        <button type="button" class="st-mode-card ${mode === 'bypass' ? 'is-active' : ''}" data-act="st-mode" data-mode="bypass">
          <div class="st-mode-top">
            <span class="st-mode-icon">${icon('zap', 18)}</span>
            <span class="st-mode-tag is-amber">Recommended</span>
            <span class="st-mode-radio"></span>
          </div>
          <div class="st-mode-title">Bypass VPN (Direct ISP)</div>
          <div class="st-mode-desc">Selected apps &amp; sites connect directly via your ISP. Everything else uses the VPN.</div>
        </button>

        <button type="button" class="st-mode-card ${mode === 'vpn_only' ? 'is-active' : ''}" data-act="st-mode" data-mode="vpn_only">
          <div class="st-mode-top">
            <span class="st-mode-icon">${icon('route', 18)}</span>
            <span class="st-mode-tag">Selective</span>
            <span class="st-mode-radio"></span>
          </div>
          <div class="st-mode-title">VPN Only (Selective Tunnel)</div>
          <div class="st-mode-desc">Only selected apps &amp; sites use the VPN. All other traffic stays on your direct ISP.</div>
        </button>
      </div>

      <!-- Telemetry Summary Bar -->
      <div class="st-pipeline-bar">
        <div class="st-pipe-cell">
          <span class="st-pipe-kicker">SELECTED RULES (${activeRuleCount})</span>
          <div class="st-pipe-val-row">
            <span class="st-pipe-dot ${mode === 'bypass' ? 'is-amber' : 'is-teal'}"></span>
            <strong class="st-pipe-val ${mode === 'bypass' ? 'is-amber' : 'is-teal'}">${selectedRouteLabel}</strong>
          </div>
        </div>
        <div class="st-pipe-sep"></div>
        <div class="st-pipe-cell">
          <span class="st-pipe-kicker">ALL OTHER TRAFFIC</span>
          <div class="st-pipe-val-row">
            <span class="st-pipe-dot ${mode === 'vpn_only' ? 'is-amber' : 'is-teal'}"></span>
            <strong class="st-pipe-val">${defaultRouteLabel}</strong>
          </div>
        </div>
        <div class="st-pipe-sep"></div>
        <div class="st-pipe-cell">
          <span class="st-pipe-kicker">ACTIVE FILTER SET</span>
          <div class="st-pipe-val-row">
            <strong class="st-pipe-val">${enabledPresetCount} App Groups · ${customTotal} Custom Rules</strong>
          </div>
        </div>
      </div>
    </section>

    <!-- 2. Main 2-Column Workspace -->
    <div class="st-workspace">
      <!-- Left Column: App & Website Groups -->
      <section class="panel st-card">
        <div class="st-card-head">
          <div class="st-card-head-text">
            <h2 class="st-card-title">App &amp; Website Groups</h2>
            <p class="st-card-sub">One-click routing presets for regional banking, gaming, streaming, and cloud platforms.</p>
          </div>
          <span class="st-count-pill ${enabledPresetCount > 0 ? 'is-active' : ''}">${enabledPresetCount} / ${PRESET_CATALOG.length} Active</span>
        </div>

        <div class="st-group-list">
          ${PRESET_CATALOG.map((preset) => {
            const on = Boolean(st.presets[preset.id]);
            return `
              <div class="st-group-item ${on ? 'is-enabled' : ''}">
                <div class="st-group-ico">${icon(preset.icon, 17)}</div>
                <div class="st-group-body">
                  <div class="st-group-top">
                    <strong class="st-group-name">${escapeHtml(preset.title)}</strong>
                    ${
                      on
                        ? `<span class="st-route-badge ${mode === 'bypass' ? 'is-direct' : 'is-vpn'}">${actionTagLabel}</span>`
                        : `<span class="st-route-badge is-muted">${preset.count} domains</span>`
                    }
                  </div>
                  <p class="st-group-desc">${escapeHtml(preset.desc)}</p>
                  <div class="st-sample-list">
                    ${preset.samples
                      .map((s) => `<span class="st-domain-tag">${escapeHtml(s)}</span>`)
                      .join('')}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  class="switch"
                  data-act="st-preset"
                  data-preset="${preset.id}"
                  aria-checked="${on}"
                  aria-label="Toggle ${escapeHtml(preset.title)}"
                ></button>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <!-- Right Column: Custom Rules + Route Path Inspector -->
      <div class="st-right-stack">
        <!-- Custom Websites & IP Subnets -->
        <section class="panel st-card">
          <div class="st-card-head">
            <div class="st-card-head-text">
              <h2 class="st-card-title">Custom Websites &amp; IP Subnets</h2>
              <p class="st-card-sub">Add any domain (<code>icanhazip.com</code>), TLD suffix (<code>.lk</code>), or IPv4/CIDR subnet (<code>203.115.0.0/16</code>).</p>
            </div>
            <span class="st-count-pill">${customTotal} Custom</span>
          </div>

          <div class="st-form-row">
            <label class="field st-field">
              ${icon('globe', 15)}
              <input
                type="text"
                data-ref="stTargetInput"
                placeholder="combank.lk, icanhazip.com, *.lk, or 203.115.0.0/16"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <button type="button" class="btn btn-primary st-submit-btn" data-act="st-add-target">
              ${icon('plus', 15)}
              <span>Add Rule</span>
            </button>
          </div>

          <div class="st-chip-bar">
            <span class="st-chip-bar-label">Quick add:</span>
            ${['icanhazip.com', 'combank.lk', 'dialog.lk', 'netflix.com', 'steampowered.com', '1.1.1.1/32']
              .map(
                (item) => `
                  <button type="button" class="st-quick-btn" data-act="st-quick-add" data-target="${escapeHtml(item)}">
                    + ${escapeHtml(item)}
                  </button>
                `
              )
              .join('')}
          </div>

          <div class="st-rules-box">
            ${
              customTotal === 0
                ? `<div class="st-empty-box">
                    <span>No custom domains or IP ranges added yet. Add a domain above or click a Quick Add chip.</span>
                  </div>`
                : `<div class="st-rule-grid">
                  ${st.customDomains
                    .map(
                      (domain) => `
                        <div class="st-rule-pill">
                          <span class="st-rule-type is-domain">DOMAIN</span>
                          <span class="st-rule-host mono">${escapeHtml(domain)}</span>
                          <span class="st-rule-arrow">${mode === 'bypass' ? '→ Direct' : mode === 'vpn_only' ? '→ VPN' : ''}</span>
                          <button
                            type="button"
                            class="st-rule-del"
                            data-act="st-rm-domain"
                            data-domain="${escapeHtml(domain)}"
                            title="Remove ${escapeHtml(domain)}"
                            aria-label="Remove ${escapeHtml(domain)}"
                          >
                            ${icon('x', 13)}
                          </button>
                        </div>
                      `
                    )
                    .join('')}
                  ${st.customIps
                    .map(
                      (ip) => `
                        <div class="st-rule-pill">
                          <span class="st-rule-type is-ip">IP/CIDR</span>
                          <span class="st-rule-host mono">${escapeHtml(ip)}</span>
                          <span class="st-rule-arrow">${mode === 'bypass' ? '→ Direct' : mode === 'vpn_only' ? '→ VPN' : ''}</span>
                          <button
                            type="button"
                            class="st-rule-del"
                            data-act="st-rm-ip"
                            data-ip="${escapeHtml(ip)}"
                            title="Remove ${escapeHtml(ip)}"
                            aria-label="Remove ${escapeHtml(ip)}"
                          >
                            ${icon('x', 13)}
                          </button>
                        </div>
                      `
                    )
                    .join('')}
                </div>`
            }
          </div>
        </section>

        <!-- Route Path Simulator -->
        <section class="panel st-card">
          <div class="st-card-head">
            <div class="st-card-head-text">
              <h2 class="st-card-title">Route Path Inspector</h2>
              <p class="st-card-sub">Trace any domain or IP address to verify which outbound interface Xray-core selects.</p>
            </div>
            <span class="st-count-pill">Live Simulator</span>
          </div>

          <div class="st-form-row">
            <label class="field st-field">
              ${icon('search', 15)}
              <input
                type="text"
                data-ref="stTestInput"
                placeholder="Enter domain or IP (e.g. icanhazip.com, combank.lk)"
                value="${escapeHtml(currentTestTarget)}"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <button type="button" class="btn st-submit-btn" data-act="st-test-route">
              ${icon('locate', 15)}
              <span>Trace Route</span>
            </button>
          </div>

          <div class="st-chip-bar">
            <span class="st-chip-bar-label">Test sample:</span>
            ${['icanhazip.com', 'dnsleaktest.com', 'combank.lk', 'steampowered.com', '192.168.1.1']
              .map(
                (sample) => `
                  <button type="button" class="st-quick-btn ${currentTestTarget === sample ? 'is-selected' : ''}" data-act="st-sample-route" data-target="${escapeHtml(sample)}">
                    ${escapeHtml(sample)}
                  </button>
                `
              )
              .join('')}
          </div>

          ${
            testResult
              ? `
                <div class="st-trace-card is-${testResult.outbound === 'adblock' ? 'block' : testResult.outbound}">
                  <div class="st-trace-flow">
                    <div class="st-trace-node">
                      <span class="st-trace-node-kicker">SOURCE</span>
                      <strong>Your Device</strong>
                    </div>
                    <div class="st-trace-arrow">──►</div>
                    <div class="st-trace-hop is-${testResult.outbound === 'adblock' ? 'block' : testResult.outbound}">
                      <span class="st-trace-node-kicker">OUTBOUND HOP</span>
                      <strong>
                        ${
                          testResult.outbound === 'direct'
                            ? `${icon('zap', 14)} ${escapeHtml(testResult.routeLabel || 'Direct ISP (Bypass VPN)')}`
                            : testResult.outbound === 'adblock'
                            ? `${icon('shield', 14)} ${escapeHtml(testResult.routeLabel || 'Blocked by Ad Shield')}`
                            : `${icon('shieldCheck', 14)} ${escapeHtml(testResult.routeLabel || 'Encrypted VPN Tunnel')}`
                        }
                      </strong>
                    </div>
                    <div class="st-trace-arrow">──►</div>
                    <div class="st-trace-node">
                      <span class="st-trace-node-kicker">DESTINATION</span>
                      <strong class="mono">${escapeHtml(testResult.target)}</strong>
                    </div>
                  </div>
                  <div class="st-trace-foot">
                    <span><strong>Matched Policy:</strong> ${escapeHtml(testResult.matchedSource || 'Default Policy')}</span>
                    <code class="st-trace-rule">${escapeHtml(testResult.matchedRule || '')}</code>
                  </div>
                </div>
              `
              : ''
          }
        </section>
      </div>
    </div>

    <!-- 3. Android Per-App Split Tunneling Studio Card -->
    <section class="panel st-card st-per-app-panel">
      <div class="st-card-head">
        <div class="st-card-head-text">
          <div class="st-title-row">
            <h2 class="st-card-title">Android Per-App Split Tunneling (VpnService App Routing)</h2>
            <span class="st-count-pill ${perAppMode !== 'off' ? 'is-active' : ''}">
              ${
                perAppMode === 'bypass_selected'
                  ? `Bypassing ${selectedApps.length} Apps`
                  : perAppMode === 'only_selected'
                    ? `VPN-Only for ${selectedApps.length} Apps`
                    : 'All Apps Follow Default Policy'
              }
            </span>
          </div>
          <p class="st-card-sub">Control which Android applications enter the system TUN interface via <code>VpnService.Builder.addDisallowedApplication</code> / <code>addAllowedApplication</code>.</p>
        </div>
      </div>

      <div class="st-per-app-toolbar">
        <div class="segmented" role="group" aria-label="Android Per-App Split Tunnel Mode">
          <button type="button" data-act="st-per-app-mode" data-mode="off" aria-pressed="${perAppMode === 'off'}">
            ${icon('shieldCheck', 14)} All Apps (Default)
          </button>
          <button type="button" data-act="st-per-app-mode" data-mode="bypass_selected" aria-pressed="${perAppMode === 'bypass_selected'}">
            ${icon('zap', 14)} Bypass Selected Apps
          </button>
          <button type="button" data-act="st-per-app-mode" data-mode="only_selected" aria-pressed="${perAppMode === 'only_selected'}">
            ${icon('route', 14)} Only Selected Apps Use VPN
          </button>
        </div>

        <label class="field st-app-search-field">
          ${icon('search', 15)}
          <input
            type="text"
            data-ref="stAppSearch"
            placeholder="Search installed Android apps or package name…"
            value="${escapeHtml(store.splitAppSearch || '')}"
            autocomplete="off"
          />
        </label>
      </div>

      <div class="st-app-grid">
        ${filteredApps
          .map((app) => {
            const isSelected = selectedApps.includes(app.packageName);
            const badgeText =
              perAppMode === 'bypass_selected' && isSelected
                ? 'BYPASS (ISP)'
                : perAppMode === 'only_selected' && isSelected
                  ? 'VPN ONLY'
                  : isSelected
                    ? 'SELECTED'
                    : 'DEFAULT';
            return `
              <div class="st-app-item ${isSelected ? 'is-selected' : ''}">
                <div class="st-app-meta">
                  <strong class="st-app-name">${escapeHtml(app.name)}</strong>
                  <span class="st-app-pkg mono">${escapeHtml(app.packageName)}</span>
                </div>
                <div class="st-app-actions">
                  <span class="st-route-badge ${
                    isSelected
                      ? perAppMode === 'bypass_selected'
                        ? 'is-direct'
                        : 'is-vpn'
                      : 'is-muted'
                  }">${badgeText}</span>
                  <button
                    type="button"
                    role="switch"
                    class="switch"
                    data-act="st-toggle-app"
                    data-pkg="${escapeHtml(app.packageName)}"
                    aria-checked="${isSelected}"
                    aria-label="Toggle ${escapeHtml(app.name)}"
                  ></button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    </section>
  </div>`;
}
