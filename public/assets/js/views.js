import { brandMark, icon } from './icons.js';
import { connState } from './dashboard.js';
import { copyText, escapeHtml, flagHtml, formatBytes, formatDuration, latencyText, latencyTitle, latencyTone, locationLabel, toast } from './ui.js';

/**
 * Centralized application branding, release version, and social/community redirect links.
 * Replace `whatsappChannelUrl`, `githubRepoUrl`, or `githubReleasesUrl` anytime before publishing.
 */
export const APP_RELEASE_INFO = {
  name: 'DragonForce Vpn',
  tagline: 'High-Performance Xray-Core Tunneling, Privacy Shield & Smart Split Router for Windows',
  version: 'v2.4.1',
  channel: 'Stable Release · GitHub Edition',
  buildDate: '2026.11',
  buildTarget: 'Windows x64 / ARM64 / x86 (TUN + System Proxy)',
  coreEngine: 'Xray-core v26.10.31 · Wintun 0.14.1',
  whatsappNumber: '0710709140',
  whatsappFormatted: '071 070 9140 (+94 71 070 9140)',
  whatsappDirectUrl: 'https://wa.me/94710709140?text=Hello%20DragonForce%20Vpn',
  whatsappChannelUrl: 'https://whatsapp.com/channel/0029VaDragonForceVPN',
  githubRepoUrl: 'https://github.com/dumidulkdev/Dragonforce-Vpn',
  githubReleasesUrl: 'https://github.com/dumidulkdev/Dragonforce-Vpn/releases',
};

function pageHead(title, desc, extra = '') {
  return `<header class="page-head"><div><h1>${title}</h1><p>${desc}</p></div>${extra}</header>`;
}

function emptyState(ic, title, text) {
  return `<div class="empty"><span class="empty-icon">${icon(ic, 20)}</span><strong>${title}</strong><p>${text}</p></div>`;
}

// ---------------------------------------------------------------- Speed Test

const PHASE_LABEL = {
  meta: 'Detecting public IP & exit server location…',
  latency: 'Measuring idle ping, jitter & TLS handshake…',
  download: 'Testing multi-stream download throughput…',
  upload: 'Testing multi-stream upload throughput…',
};

export function renderSpeed(root, store) {
  const st = store.status;
  const conn = connState(st);
  const activeNode = store.data.servers.find((s) => s.id === st?.activeServerId) || null;
  const live = store.speedTest;
  const running = !!live?.running;
  const history = store.data.speedTests || [];
  const current = running ? live.partial || {} : live?.result || history[0] || null;

  const routeIsVpn = running ? live.route === 'vpn' : current ? current.route === 'vpn' : conn === 'connected';
  const routeServer = running
    ? live.serverName
    : current?.serverName || (conn === 'connected' ? activeNode?.name : null);

  const fallbackGeo = conn === 'connected' ? st?.exitGeo || activeNode?.geo : store.data.originGeo;
  const ip = current?.ip || fallbackGeo?.ip || null;
  const countryCode = current?.countryCode || fallbackGeo?.countryCode || null;
  const city = current?.city || fallbackGeo?.city || null;
  const country = current?.country || fallbackGeo?.country || null;
  const locText = [city, country].filter(Boolean).join(', ') || (ip ? 'Resolved' : 'Run test to detect');
  const ispText = current?.isp || (routeIsVpn && activeNode ? `${activeNode.address}:${activeNode.port}` : '—');
  const coloText = current?.colo ? `Cloudflare ${current.colo}` : 'Cloudflare Edge';

  const downVal =
    running && live.phase === 'download' && live.mbps !== undefined
      ? live.mbps
      : current?.downloadMbps ?? null;
  const upVal =
    running && live.phase === 'upload' && live.mbps !== undefined
      ? live.mbps
      : current?.uploadMbps ?? null;
  const pingVal = current?.pingMs ?? null;
  const jitterVal = current?.jitterMs ?? null;
  const handshakeVal = current?.handshakeMs ?? null;

  const pct = running ? Math.round((live.progress || 0) * 100) : live?.done && !live?.error ? 100 : 0;
  const phaseOrder = ['meta', 'latency', 'download', 'upload'];
  const activePhaseIdx = running ? phaseOrder.indexOf(live.phase) : -1;

  const stepsHtml = [
    ['meta', 'IP & Location'],
    ['latency', 'Ping & Handshake'],
    ['download', 'Download'],
    ['upload', 'Upload'],
  ]
    .map(([key, label], idx) => {
      const state = running
        ? idx < activePhaseIdx
          ? 'is-done'
          : idx === activePhaseIdx
            ? 'is-active'
            : ''
        : current
          ? 'is-done'
          : '';
      return `<div class="speed-step ${state}"><span class="speed-step-dot"></span><span>${label}</span></div>`;
    })
    .join('');

  const historyRows = history
    .map((h) => {
      const loc = [h.city, h.country].filter(Boolean).join(', ') || '—';
      const routeBadge =
        h.route === 'vpn'
          ? `<span class="tag is-accent">VPN · ${escapeHtml(h.serverName || 'Tunnel')}</span>`
          : `<span class="tag">Direct</span>`;
      return `<tr>
        <td class="num" style="color:var(--text-2);font-size:12px">${new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
        <td>${routeBadge}</td>
        <td><div class="cell-server">${flagHtml(h.countryCode, 24)}<div style="min-width:0"><strong class="mono">${escapeHtml(h.ip || '—')}</strong><span>${escapeHtml(loc)}${h.colo ? ` · Edge ${escapeHtml(h.colo)}` : ''}</span></div></div></td>
        <td class="num">${h.pingMs !== null ? `${h.pingMs} ms` : '—'}${h.handshakeMs ? ` <span style="color:var(--text-3);font-size:11px">(${h.handshakeMs} ms TLS)</span>` : ''}</td>
        <td class="num tone-good" style="font-weight:600">${h.downloadMbps !== null ? `${h.downloadMbps.toFixed(1)} Mbps` : '—'}</td>
        <td class="num" style="font-weight:600">${h.uploadMbps !== null ? `${h.uploadMbps.toFixed(1)} Mbps` : '—'}</td>
      </tr>`;
    })
    .join('');

  root.innerHTML = `<div class="page">
    ${pageHead(
      'Speed test',
      'Measure real-time download and upload throughput, latency, new-page TLS handshake speed, exit location, and public IP.',
      running
        ? `<button class="btn btn-danger" data-act="speed-cancel">${icon('x', 16)}Stop test</button>`
        : `<button class="btn btn-primary" data-act="speed-start">${icon('zap', 16)}Start speed test</button>`
    )}

    <section class="panel section speed-hero">
      <div class="speed-hero-top">
        <div class="speed-route-badges">
          <span class="speed-pill ${conn === 'connected' ? 'is-vpn' : ''}">
            <span class="status-dot ${conn === 'connected' ? 'is-on' : ''}"></span>
            ${conn === 'connected' ? `Routing via VPN · ${escapeHtml(activeNode?.name || 'Connected')}` : 'Direct connection (VPN disconnected)'}
          </span>
          <span class="speed-pill">
            ${icon('zap', 14)}
            ${st?.tunActive ? (st.platform === 'linux' ? 'Linux IPv4 TUN active' : 'Hybrid TUN + Direct HTTP CONNECT active') : 'Direct HTTP CONNECT active'}
          </span>
        </div>
        <div class="speed-status-text num">
          ${running ? `${PHASE_LABEL[live.phase] || 'Testing…'} · ${pct}%` : live?.error ? `<span class="tone-bad">${escapeHtml(live.error)}</span>` : current ? `Last measured at ${new Date(current.timestamp || Date.now()).toLocaleTimeString()}` : 'Ready to measure your active connection'}
        </div>
      </div>

      <div class="speed-progress-track" aria-hidden="true">
        <div class="speed-progress-bar${running ? ' is-running' : ''}" style="width:${pct}%"></div>
      </div>

      <div class="speed-steps">${stepsHtml}</div>
    </section>

    <div class="speed-cards">
      <section class="panel speed-card ${running && live.phase === 'download' ? 'is-live' : ''}">
        <div class="speed-card-head">
          <span class="chip chip-down">${icon('arrowDown', 15)}</span>
          <span>Download</span>
          ${running && live.phase === 'download' ? '<span class="speed-live-tag">LIVE</span>' : ''}
        </div>
        <div class="speed-card-val num">${downVal !== null ? downVal.toFixed(1) : '—'}<small>Mbps</small></div>
        <div class="speed-card-sub">Multi-stream HTTPS download</div>
      </section>

      <section class="panel speed-card ${running && live.phase === 'upload' ? 'is-live' : ''}">
        <div class="speed-card-head">
          <span class="chip chip-up">${icon('arrowUp', 15)}</span>
          <span>Upload</span>
          ${running && live.phase === 'upload' ? '<span class="speed-live-tag">LIVE</span>' : ''}
        </div>
        <div class="speed-card-val num">${upVal !== null ? upVal.toFixed(1) : '—'}<small>Mbps</small></div>
        <div class="speed-card-sub">Multi-stream HTTPS upload</div>
      </section>

      <section class="panel speed-card ${running && live.phase === 'latency' ? 'is-live' : ''}">
        <div class="speed-card-head">
          <span class="chip">${icon('gauge', 15)}</span>
          <span>Ping & Jitter</span>
        </div>
        <div class="speed-card-val num">${pingVal !== null ? pingVal : '—'}<small>ms</small></div>
        <div class="speed-card-sub">Jitter: <strong class="num">${jitterVal !== null ? `${jitterVal} ms` : '—'}</strong></div>
      </section>

      <section class="panel speed-card ${running && live.phase === 'latency' ? 'is-live' : ''}">
        <div class="speed-card-head">
          <span class="chip">${icon('zap', 15)}</span>
          <span>Page Handshake</span>
        </div>
        <div class="speed-card-val num">${handshakeVal !== null ? handshakeVal : '—'}<small>ms</small></div>
        <div class="speed-card-sub">New HTTPS site connect time</div>
      </section>
    </div>

    <section class="panel section">
      <div class="section-title">Public IP & Server Location</div>
      <div class="section-desc">Externally visible network identity and test edge server used for this connection.</div>
      <div class="speed-identity-grid">
        <div class="speed-id-item">
          <span class="speed-id-label">${icon('network', 15)}Public IP Address</span>
          <div class="speed-id-val">
            <span class="mono">${escapeHtml(ip || '—')}</span>
            ${ip ? `<button class="btn btn-ghost btn-icon btn-sm" data-act="copy-ip" data-ip="${escapeHtml(ip)}" title="Copy IP">${icon('copy', 14)}</button>` : ''}
          </div>
        </div>
        <div class="speed-id-item">
          <span class="speed-id-label">${icon('pin', 15)}Server / Exit Location</span>
          <div class="speed-id-val">
            ${flagHtml(countryCode, 22)}
            <span>${escapeHtml(locText)}</span>
          </div>
        </div>
        <div class="speed-id-item">
          <span class="speed-id-label">${icon('server', 15)}Network / Provider</span>
          <div class="speed-id-val">
            <span title="${escapeHtml(ispText)}">${escapeHtml(ispText)}</span>
          </div>
        </div>
        <div class="speed-id-item">
          <span class="speed-id-label">${icon('route', 15)}Test Edge & Route</span>
          <div class="speed-id-val">
            <span>${escapeHtml(coloText)} · ${routeIsVpn ? `VPN (${escapeHtml(routeServer || 'Active')})` : 'Direct'}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="panel section">
      <div class="section-title">Recent speed tests</div>
      <div class="section-desc">Compare performance across servers or between VPN and direct connections.</div>
      <div style="margin-top:12px">
        ${history.length
          ? `<table class="table"><thead><tr><th>Time</th><th>Route</th><th>Public IP & Location</th><th>Ping</th><th>Download</th><th>Upload</th></tr></thead><tbody>${historyRows}</tbody></table>`
          : emptyState('gauge', 'No speed tests yet', 'Click "Start speed test" above to measure your download, upload, ping, and exit IP.')}
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- Servers

export function renderServers(root, store) {
  const servers = store.data.servers || [];
  const activeId = store.status?.activeServerId;
  const conn = connState(store.status);
  const perServerUsage = store.data.usageHistory?.perServer || {};
  const filterProto = store.serverFilter || 'all';
  const sortMode = store.serverSort || 'default';
  const searchQuery = (store.serverSearch || '').trim().toLowerCase();

  const vlessCount = servers.filter((s) => s.protocol === 'vless').length;
  const vmessCount = servers.filter((s) => s.protocol === 'vmess').length;
  const reachableNodes = servers.filter((s) => typeof s.ping === 'number' && s.ping >= 0);
  const fastestNode = reachableNodes.length
    ? [...reachableNodes].sort((a, b) => a.ping - b.ping)[0]
    : null;
  const activeNode = servers.find((s) => s.id === activeId) || servers[0] || null;

  const totalDown = store.status?.stats?.totalDown ?? store.data.totalDown ?? 0;
  const totalUp = store.status?.stats?.totalUp ?? store.data.totalUp ?? 0;

  let filtered = servers.filter((s) => {
    if (filterProto !== 'all' && s.protocol !== filterProto) return false;
    if (!searchQuery) return true;
    return [s.name, s.address, s.sni, s.host, s.geo?.country, s.geo?.city, s.protocol, s.network]
      .some((v) => v && String(v).toLowerCase().includes(searchQuery));
  });

  if (sortMode === 'ping') {
    filtered = [...filtered].sort((a, b) => {
      const pa = typeof a.ping === 'number' && a.ping >= 0 ? a.ping : 999999;
      const pb = typeof b.ping === 'number' && b.ping >= 0 ? b.ping : 999999;
      return pa - pb;
    });
  }

  const cardsHtml = filtered
    .map((s) => {
      const selected = s.id === activeId;
      const live = selected && conn === 'connected';
      const tone = latencyTone(s.ping);
      const sniOrHost = s.sni || s.host || null;
      const usageRec = perServerUsage[s.id];
      const usedBytes = (usageRec?.downBytes || 0) + (usageRec?.upBytes || 0);
      const where = s.geo ? locationLabel(s.geo) : 'Resolving geo…';

      return `
      <article class="srv-node-card ${selected ? 'is-selected' : ''} ${live ? 'is-live' : ''}" data-id="${s.id}">
        <!-- Col 1: Flag, Remarks & Endpoint -->
        <div class="srv-col-main">
          <div class="srv-flag-wrap">
            ${flagHtml(s.geo?.countryCode, 38)}
            <span class="srv-flag-dot ${live ? 'is-live' : selected ? 'is-selected' : ''}"></span>
          </div>
          <div class="srv-identity">
            <div class="srv-name-row">
              <strong class="srv-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</strong>
              ${
                live
                  ? '<span class="srv-status-pill is-live"><span class="status-dot is-on"></span>Connected</span>'
                  : selected
                    ? '<span class="srv-status-pill is-selected">Active</span>'
                    : ''
              }
            </div>
            <div class="srv-endpoint mono" title="${escapeHtml(s.address)}:${s.port}">
              ${escapeHtml(s.address)}<span>:${s.port}</span>
            </div>
          </div>
        </div>

        <!-- Col 2: Location & SNI / Bug Host -->
        <div class="srv-col-loc">
          <div class="srv-loc-primary">
            ${icon('pin', 14)}
            <span>${escapeHtml(where)}</span>
          </div>
          <div class="srv-loc-sub mono" title="${escapeHtml(sniOrHost || s.address)}">
            <span class="srv-meta-key">${s.sni ? 'SNI' : s.host ? 'HOST' : 'DIRECT'}</span>
            <strong>${escapeHtml(sniOrHost || 'Default')}</strong>
          </div>
        </div>

        <!-- Col 3: Transport Stack & Bandwidth -->
        <div class="srv-col-proto">
          <div class="tags">
            <span class="tag ${s.protocol === 'vless' ? 'is-accent' : ''}">${escapeHtml(s.protocol)}</span>
            <span class="tag">${escapeHtml(s.network)}</span>
            ${s.security !== 'none' ? `<span class="tag">${escapeHtml(s.security)}</span>` : ''}
            ${s.allowInsecure ? `<span class="tag is-warn" title="Unverified TLS certificate accepted and pinned at connection time">Pinned</span>` : ''}
          </div>
          <div class="srv-traffic-meta num">
            ${
              usedBytes > 0
                ? `<span>↓ ${formatBytes(usageRec.downBytes || 0)}</span><span class="srv-dot-sep">·</span><span>↑ ${formatBytes(usageRec.upBytes || 0)}</span>`
                : '<span class="tone-none">No traffic recorded yet</span>'
            }
          </div>
        </div>

        <!-- Col 4: Latency & Signal Meter -->
        <div class="srv-col-ping">
          <div class="srv-ping-box" data-tone="${tone}" title="${escapeHtml(latencyTitle(s))}">
            <span class="srv-ping-val num tone-${tone}">${latencyText(s.ping, s.pingStatus)}</span>
            <span class="signal" data-tone="${tone}" aria-hidden="true"><i></i><i></i><i></i></span>
          </div>
          <span class="srv-ping-caption">${
            s.pingStatus === 'measuring' ? 'Measuring TCP latency' : s.ping == null ? 'Not tested' : s.ping < 0 ? 'Connection test failed' : tone === 'good' ? 'Low latency' : tone === 'fair' ? 'Moderate latency' : 'High latency'
          }</span>
        </div>

        <!-- Col 5: Connect Button & Segmented Studio Action Dock -->
        <div class="srv-col-actions">
          <button
            type="button"
            class="btn btn-sm srv-connect-btn ${live ? 'is-connected' : selected ? 'btn-primary' : ''}"
            data-act="quick-connect"
            data-id="${s.id}"
            title="${live ? 'Disconnect tunnel' : 'Connect to this server'}"
          >
            ${icon('power', 14)}
            <span>${live ? 'Disconnect' : selected ? 'Connect' : 'Use Node'}</span>
          </button>

          <div class="srv-action-dock" role="group" aria-label="Server actions">
            <button type="button" class="srv-dock-btn" data-act="ping" data-id="${s.id}" title="Measure direct TCP latency" ${s.pingStatus === 'measuring' ? 'disabled' : ''}>${icon('gauge', 15)}</button>
            <button type="button" class="srv-dock-btn" data-act="qr-server" data-id="${s.id}" title="Generate scannable QR code">${icon('qr', 15)}</button>
            <button type="button" class="srv-dock-btn" data-act="edit-server" data-id="${s.id}" title="Edit SNI, Host, Port & Remarks">${icon('pencil', 15)}</button>
            <button type="button" class="srv-dock-btn" data-act="config" data-id="${s.id}" title="Inspect Xray-core JSON config">${icon('code', 15)}</button>
            <button type="button" class="srv-dock-btn" data-act="copy-link" data-id="${s.id}" title="Copy vless:// or vmess:// share link">${icon('copy', 15)}</button>
            <button type="button" class="srv-dock-btn is-danger" data-act="delete-server" data-id="${s.id}" title="Delete server">${icon('trash', 15)}</button>
          </div>
        </div>
      </article>`;
    })
    .join('');

  root.innerHTML = `<div class="page srv-page">
    ${pageHead(
      'Servers & Node Fleet',
      'Import VLESS and VMess endpoints, customize SNI and Bug Host headers, generate mobile QR passes, and benchmark route latency.',
      `<div class="srv-head-actions">
        <button type="button" class="btn" data-act="scan-qr">${icon('qr', 16)}Scan QR Code</button>
        ${servers.length ? `<button type="button" class="btn btn-primary" data-act="ping-all" ${servers.some((s) => s.pingStatus === 'measuring') ? 'disabled' : ''}>${icon('gauge', 16)}Measure All (${servers.length})</button>` : ''}
      </div>`
    )}

    <!-- 4-Card Fleet Telemetry KPI Strip -->
    <div class="srv-kpi-grid">
      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('server', 17)}</span>
          <span class="srv-kpi-label">Configured Fleet</span>
        </div>
        <div class="srv-kpi-val num">${servers.length} <small>${servers.length === 1 ? 'Node' : 'Nodes'}</small></div>
        <div class="srv-kpi-foot">
          <span><strong>${vlessCount}</strong> VLESS</span>
          <span class="srv-dot-sep">·</span>
          <span><strong>${vmessCount}</strong> VMess</span>
          <span class="srv-dot-sep">·</span>
          <span class="tone-good"><strong>${reachableNodes.length}</strong> Online</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon is-teal">${icon('shieldCheck', 17)}</span>
          <span class="srv-kpi-label">Selected Endpoint</span>
        </div>
        <div class="srv-kpi-node">
          ${activeNode ? flagHtml(activeNode.geo?.countryCode, 26) : ''}
          <strong title="${escapeHtml(activeNode?.name || 'None')}">${escapeHtml(activeNode?.name || 'No server selected')}</strong>
        </div>
        <div class="srv-kpi-foot">
          <span class="status-dot ${conn === 'connected' ? 'is-on' : ''}"></span>
          <span>${conn === 'connected' ? 'Tunnel active' : activeNode ? `${activeNode.protocol.toUpperCase()} · Standby` : 'Import a node below'}</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('zap', 17)}</span>
          <span class="srv-kpi-label">Fastest Route</span>
        </div>
        <div class="srv-kpi-val num ${fastestNode ? 'tone-good' : ''}">
          ${fastestNode ? `${fastestNode.ping} <small>ms</small>` : '—'}
        </div>
        <div class="srv-kpi-foot" title="${escapeHtml(fastestNode?.name || '')}">
          <span>${fastestNode ? `${escapeHtml(fastestNode.name)} (${escapeHtml(fastestNode.geo?.country || fastestNode.address)})` : 'Click "Measure All" to benchmark'}</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('chart', 17)}</span>
          <span class="srv-kpi-label">Fleet Bandwidth</span>
        </div>
        <div class="srv-kpi-val num">${formatBytes(totalDown + totalUp)}</div>
        <div class="srv-kpi-foot num">
          <span>↓ ${formatBytes(totalDown)}</span>
          <span class="srv-dot-sep">·</span>
          <span>↑ ${formatBytes(totalUp)}</span>
        </div>
      </section>
    </div>

    <!-- Studio Link & QR Import Bar -->
    <section class="panel srv-import-panel">
      <div class="srv-import-head">
        <div>
          <div class="section-title">Quick Import Server or Share Link</div>
          <div class="section-desc">Paste one or more vless:// or vmess:// URIs, a Base64 node list, or scan a QR code from your screen or clipboard.</div>
        </div>
        <div class="srv-proto-pills" aria-hidden="true">
          <span>VLESS</span><span>VMess</span><span>TLS 1.3</span><span>Reality</span><span>WS / gRPC / TCP</span>
        </div>
      </div>

      <div class="srv-import-bar">
        <label class="field srv-import-field">
          ${icon('link', 16)}
          <input data-ref="linkInput" placeholder="Paste vless://… or vmess://… share URI or Base64 list" aria-label="Share link" />
        </label>
        <button type="button" class="btn" data-act="paste">${icon('clipboard', 16)}Paste Clipboard</button>
        <button type="button" class="btn" data-act="scan-qr" title="Scan QR code from screen, clipboard, or image">${icon('qr', 16)}Scan QR</button>
        <button type="button" class="btn btn-primary srv-import-submit" data-act="import">${icon('plus', 16)}Import Node</button>
      </div>
    </section>

    <!-- Fleet Directory Panel -->
    <section class="panel srv-fleet-panel">
      <div class="srv-toolbar">
        <div class="srv-toolbar-left">
          <div class="segmented" role="group" aria-label="Filter protocol">
            <button type="button" data-act="srv-filter" data-proto="all" aria-pressed="${filterProto === 'all'}">All (${servers.length})</button>
            <button type="button" data-act="srv-filter" data-proto="vless" aria-pressed="${filterProto === 'vless'}">VLESS (${vlessCount})</button>
            <button type="button" data-act="srv-filter" data-proto="vmess" aria-pressed="${filterProto === 'vmess'}">VMess (${vmessCount})</button>
          </div>
          <button
            type="button"
            class="btn btn-sm ${sortMode === 'ping' ? 'is-selected-chip' : ''}"
            data-act="srv-sort"
            title="Sort servers by lowest latency"
          >
            ${icon('gauge', 14)}<span>${sortMode === 'ping' ? 'Sorted: Fastest Ping' : 'Sort by Ping'}</span>
          </button>
        </div>

        <div class="srv-toolbar-right">
          <label class="field field-muted srv-search-field">
            ${icon('search', 15)}
            <input
              type="search"
              data-ref="srvSearch"
              value="${escapeHtml(store.serverSearch || '')}"
              placeholder="Search server, SNI, host, or country…"
              aria-label="Search servers"
            />
          </label>
        </div>
      </div>

      ${
        servers.length
          ? filtered.length
            ? `
          <div class="srv-list-head" aria-hidden="true">
            <span>Server & Endpoint</span>
            <span>Location & SNI / Host</span>
            <span>Protocol & Traffic</span>
            <span>Latency</span>
            <span style="text-align:right">Connection & Tools</span>
          </div>
          <div class="srv-card-list">
            ${cardsHtml}
          </div>`
            : emptyState('search', 'No matching servers', `No server matches "${escapeHtml(store.serverSearch || filterProto)}".`)
          : emptyState('server', 'No servers configured yet', 'Paste a vless:// or vmess:// link above or click Scan QR to import your first server.')
      }
    </section>
  </div>`;
}

// ---------------------------------------------------------------- Subscriptions

function extractHost(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

function formatRelativeSync(ts) {
  if (!ts) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Computes comprehensive provider + local usage, quota, expiry, and node fleet metrics for a subscription.
 */
function computeSubMetrics(sub, store) {
  const allServers = store.data.servers || [];
  const perServerUsage = store.data.usageHistory?.perServer || {};
  const subNodes = allServers.filter((s) => s.subscriptionId === sub.id);
  const nodeCount = subNodes.length || sub.nodeCount || 0;

  let localDown = 0;
  let localUp = 0;
  let localSessions = 0;
  let localConnectedSeconds = 0;

  for (const s of subNodes) {
    const rec = perServerUsage[s.id];
    if (rec) {
      localDown += rec.downBytes || 0;
      localUp += rec.upBytes || 0;
      localSessions += rec.sessions || 0;
      localConnectedSeconds += rec.connectedSeconds || 0;
    }
  }

  const providerDown = sub.downloadBytes || 0;
  const providerUp = sub.uploadBytes || 0;
  const providerTotalUsed = providerDown + providerUp;
  const localTotalUsed = localDown + localUp;

  let downBytes = Math.max(providerDown, localDown);
  let upBytes = Math.max(providerUp, localUp);
  if (providerTotalUsed > 0 && downBytes === 0 && upBytes === 0) {
    downBytes = Math.round(providerTotalUsed * 0.85);
    upBytes = providerTotalUsed - downBytes;
  }
  const usedBytes = Math.max(providerTotalUsed, localTotalUsed, downBytes + upBytes);
  const totalBytes = sub.totalBytes && sub.totalBytes > 0 ? sub.totalBytes : 0;
  const hasQuota = totalBytes > 0;
  const remainingBytes = hasQuota ? Math.max(0, totalBytes - usedBytes) : 0;
  const usedPct = hasQuota ? Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10) : null;

  const dlSharePct = usedBytes > 0 ? Math.round((downBytes / usedBytes) * 100) : 0;
  const ulSharePct = usedBytes > 0 ? Math.max(0, 100 - dlSharePct) : 0;

  const now = Date.now();
  const expireTs = sub.expireTimestamp && sub.expireTimestamp > 0 ? sub.expireTimestamp : null;
  const createdTs = sub.createdAt || (expireTs ? expireTs - 30 * 86400000 : sub.updatedAt - 7 * 86400000);
  const daysLeft = expireTs ? Math.ceil((expireTs - now) / 86400000) : null;
  const isExpired = expireTs ? expireTs <= now : false;
  const isExpiringSoon = daysLeft !== null && daysLeft > 0 && daysLeft <= 7;
  const totalCycleDays = expireTs ? Math.max(1, Math.round((expireTs - createdTs) / 86400000)) : 30;
  const remainingDaysClamped = expireTs ? Math.max(0, Math.min(totalCycleDays, daysLeft || 0)) : 30;
  const elapsedDaysClamped = expireTs ? Math.max(0, totalCycleDays - remainingDaysClamped) : 0;

  const reachableNodes = subNodes.filter((s) => typeof s.ping === 'number' && s.ping >= 0);
  const optimalNodes = reachableNodes.filter((s) => s.ping < 120);
  const fairNodes = reachableNodes.filter((s) => s.ping >= 120);
  const untestedOrOfflineNodes = subNodes.filter((s) => typeof s.ping !== 'number' || s.ping < 0);
  const avgPing = reachableNodes.length
    ? Math.round(reachableNodes.reduce((acc, s) => acc + s.ping, 0) / reachableNodes.length)
    : null;
  const fastestNode = reachableNodes.length
    ? [...reachableNodes].sort((a, b) => a.ping - b.ping)[0]
    : null;

  const vlessCount = subNodes.filter((s) => s.protocol === 'vless').length;
  const vmessCount = subNodes.filter((s) => s.protocol === 'vmess').length;
  const activeNode = subNodes.find((s) => s.id === store.status?.activeServerId) || null;
  const isLive = Boolean(activeNode && connState(store.status) === 'connected');

  return {
    subNodes,
    nodeCount,
    downBytes,
    upBytes,
    usedBytes,
    totalBytes,
    hasQuota,
    remainingBytes,
    usedPct,
    dlSharePct,
    ulSharePct,
    localDown,
    localUp,
    localTotalUsed,
    localSessions,
    localConnectedSeconds,
    expireTs,
    createdTs,
    daysLeft,
    isExpired,
    isExpiringSoon,
    totalCycleDays,
    remainingDaysClamped,
    elapsedDaysClamped,
    reachableNodes,
    optimalNodes,
    fairNodes,
    untestedOrOfflineNodes,
    avgPing,
    fastestNode,
    vlessCount,
    vmessCount,
    activeNode,
    isLive,
  };
}

/**
 * Renders a studio SVG Pie / Donut chart with geometric wedge paths, crisp white slice dividers,
 * and an optional center badge readout.
 */
function renderStudioPieSvg({
  size = 96,
  innerRatio = 0.56,
  slices = [],
  centerTop = '',
  centerSub = '',
}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 3;
  const rInner = Math.round(rOuter * innerRatio);

  const positive = slices.filter((s) => s.value > 0);
  const total = positive.reduce((acc, s) => acc + s.value, 0);

  let pathsHtml = '';
  if (total <= 0) {
    pathsHtml = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="var(--surface-3)" />`;
  } else if (positive.length === 1) {
    const s = positive[0];
    pathsHtml = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${s.color}"><title>${escapeHtml(s.label)}</title></circle>`;
  } else {
    let angle = -Math.PI / 2;
    for (const s of positive) {
      const frac = Math.max(0.015, s.value / total);
      const sweep = Math.min(Math.PI * 1.999, frac * Math.PI * 2);
      const endAngle = angle + sweep;
      const x1 = cx + rOuter * Math.cos(angle);
      const y1 = cy + rOuter * Math.sin(angle);
      const x2 = cx + rOuter * Math.cos(endAngle);
      const y2 = cy + rOuter * Math.sin(endAngle);
      const largeArc = sweep > Math.PI ? 1 : 0;

      const d = `M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      pathsHtml += `<path d="${d}" fill="${s.color}" stroke="var(--surface)" stroke-width="2" stroke-linejoin="round"><title>${escapeHtml(s.label)}</title></path>`;
      angle = endAngle;
    }
  }

  const topFontSize = size >= 120 ? 15 : 12;
  const subFontSize = size >= 120 ? 9.5 : 8.2;

  return `<svg class="sub-pie-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(centerTop)} ${escapeHtml(centerSub)}">
    ${pathsHtml}
    ${
      rInner > 0
        ? `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="var(--surface)" />
           <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--border)" stroke-width="1" />`
        : ''
    }
    ${
      centerTop
        ? `<text x="${cx}" y="${centerSub ? cy - 2 : cy + 4}" text-anchor="middle" fill="var(--text)" font-size="${topFontSize}" font-weight="700" font-family="Poppins, sans-serif">${escapeHtml(centerTop)}</text>`
        : ''
    }
    ${
      centerSub
        ? `<text x="${cx}" y="${cy + (size >= 120 ? 13 : 10)}" text-anchor="middle" fill="var(--text-3)" font-size="${subFontSize}" font-weight="600" letter-spacing="0.04em" font-family="Poppins, sans-serif">${escapeHtml(centerSub)}</text>`
        : ''
    }
  </svg>`;
}

export function renderSubscriptions(root, store) {
  const subs = store.data.subscriptions || [];
  const enriched = subs.map((sub) => ({ sub, m: computeSubMetrics(sub, store) }));

  const totalSubs = subs.length;
  const totalSubNodes = enriched.reduce((acc, x) => acc + x.m.nodeCount, 0);
  const totalUsedAll = enriched.reduce((acc, x) => acc + x.m.usedBytes, 0);
  const totalDownAll = enriched.reduce((acc, x) => acc + x.m.downBytes, 0);
  const totalUpAll = enriched.reduce((acc, x) => acc + x.m.upBytes, 0);
  const totalQuotaAll = enriched.reduce((acc, x) => acc + x.m.totalBytes, 0);

  const expiringList = enriched
    .filter((x) => x.m.expireTs)
    .sort((a, b) => a.m.expireTs - b.m.expireTs);
  const nearestExpiry = expiringList[0] || null;
  const latestSyncTs = subs.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0);

  const cardsHtml = enriched
    .map(({ sub, m }) => {
      const hostLabel = extractHost(sub.url);

      // Pie Chart 1: Data Usage & Quota Distribution
      const usageSlices = m.hasQuota
        ? [
            { value: Math.max(m.downBytes, 1), color: '#00A896', label: `Download: ${formatBytes(m.downBytes)}` },
            { value: Math.max(m.upBytes, 0), color: '#0F2942', label: `Upload: ${formatBytes(m.upBytes)}` },
            { value: Math.max(m.remainingBytes, 0), color: '#E6EEF4', label: `Remaining: ${formatBytes(m.remainingBytes)}` },
          ]
        : m.usedBytes > 0
          ? [
              { value: Math.max(m.downBytes, 1), color: '#00A896', label: `Download: ${formatBytes(m.downBytes)} (${m.dlSharePct}%)` },
              { value: Math.max(m.upBytes, Math.round(m.usedBytes * 0.04)), color: '#2563EB', label: `Upload: ${formatBytes(m.upBytes)} (${m.ulSharePct}%)` },
            ]
          : [{ value: 1, color: '#CBD5E1', label: 'No traffic recorded yet' }];

      const usagePieSvg = renderStudioPieSvg({
        size: 92,
        innerRatio: 0.58,
        slices: usageSlices,
        centerTop: m.hasQuota ? `${Math.round(m.usedPct)}%` : formatBytes(m.usedBytes),
        centerSub: m.hasQuota ? 'QUOTA' : 'USED',
      });

      // Pie Chart 2: Validity / Expiry & Node Health
      const expirySlices = m.expireTs
        ? m.isExpired
          ? [{ value: 1, color: '#D64545', label: 'Subscription Expired' }]
          : [
              {
                value: Math.max(1, m.remainingDaysClamped),
                color: m.isExpiringSoon ? '#D9822B' : '#00A896',
                label: `Remaining: ${Math.max(0, m.daysLeft)} days`,
              },
              {
                value: Math.max(0, m.elapsedDaysClamped),
                color: '#E6EEF4',
                label: `Elapsed: ${m.elapsedDaysClamped} days`,
              },
            ]
        : [
            {
              value: Math.max(1, m.reachableNodes.length || m.nodeCount || 1),
              color: '#00A896',
              label: `Active Nodes: ${m.nodeCount}`,
            },
            {
              value: Math.max(0, m.untestedOrOfflineNodes.length),
              color: '#BAE6FD',
              label: `Standby Nodes: ${m.untestedOrOfflineNodes.length}`,
            },
          ];

      const expiryPieSvg = renderStudioPieSvg({
        size: 92,
        innerRatio: 0.52,
        slices: expirySlices,
        centerTop: m.expireTs ? (m.isExpired ? 'EXP' : `${Math.max(0, m.daysLeft)}d`) : '∞',
        centerSub: m.expireTs ? (m.isExpired ? 'ENDED' : 'LEFT') : 'ACTIVE',
      });

      const statusBadge = m.isExpired
        ? '<span class="sub-status-pill is-danger">Expired</span>'
        : m.isExpiringSoon
          ? `<span class="sub-status-pill is-warn">Expires in ${m.daysLeft}d</span>`
          : m.isLive
            ? '<span class="sub-status-pill is-live"><span class="status-dot is-on"></span>Connected</span>'
            : '<span class="sub-status-pill is-ok">Active Feed</span>';

      const previewNodes = m.subNodes.slice(0, 3);

      return `
      <article class="panel sub-studio-card ${m.isLive ? 'is-live' : ''}" data-sub-id="${sub.id}">
        <!-- Card Top Header -->
        <div class="sub-card-head">
          <div class="sub-card-identity">
            <div class="sub-avatar">
              ${icon('rss', 19)}
            </div>
            <div class="sub-title-wrap">
              <div class="sub-title-row">
                <h3 class="sub-card-title">${escapeHtml(sub.name)}</h3>
                ${statusBadge}
                <span class="sub-host-pill mono" title="${escapeHtml(sub.url)}">${escapeHtml(hostLabel)}</span>
              </div>
              <div class="sub-url-row">
                <span class="sub-url-text mono" title="${escapeHtml(sub.url)}">${escapeHtml(sub.url)}</span>
                <button type="button" class="sub-inline-copy" data-act="copy-sub-url" data-url="${escapeHtml(sub.url)}" title="Copy subscription URL">
                  ${icon('copy', 12)}<span>Copy URL</span>
                </button>
              </div>
            </div>
          </div>

          <div class="sub-card-actions">
            <button type="button" class="btn btn-primary btn-sm sub-view-btn" data-act="view-sub" data-id="${sub.id}" title="Open full subscription analytics & node inspector">
              ${icon('eye', 15)}<span>View Details</span>
            </button>
            <button type="button" class="btn btn-sm" data-act="ping-sub" data-id="${sub.id}" title="Benchmark all servers in this subscription">
              ${icon('gauge', 15)}<span>Ping (${m.nodeCount})</span>
            </button>
            <button type="button" class="btn btn-sm" data-act="sync-sub" data-id="${sub.id}" title="Sync latest nodes and quota from provider">
              ${icon('refresh', 15)}<span>Sync</span>
            </button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-act="delete-sub" data-id="${sub.id}" title="Remove subscription and its servers">
              ${icon('trash', 15)}
            </button>
          </div>
        </div>

        <!-- Card 3-Column Studio Analytics Body -->
        <div class="sub-card-body">
          <!-- Column 1: Data Usage Pie Chart -->
          <div class="sub-chart-box" data-act="view-sub" data-id="${sub.id}" title="Click to inspect detailed bandwidth breakdown">
            <div class="sub-pie-wrap">
              ${usagePieSvg}
            </div>
            <div class="sub-chart-info">
              <div class="sub-chart-kicker">Bandwidth & Quota</div>
              <div class="sub-chart-headline num">
                <strong>${formatBytes(m.usedBytes)}</strong>
                <span>${m.hasQuota ? `of ${formatBytes(m.totalBytes)}` : '· Unlimited Plan'}</span>
              </div>
              <div class="sub-chart-legend num">
                <span class="sub-leg-item"><i style="background:#00A896"></i>↓ ${formatBytes(m.downBytes)} (${m.dlSharePct}%)</span>
                <span class="sub-leg-item"><i style="background:${m.hasQuota ? '#0F2942' : '#2563EB'}"></i>↑ ${formatBytes(m.upBytes)} (${m.ulSharePct}%)</span>
              </div>
              ${
                m.hasQuota
                  ? `<div class="sub-mini-quota"><i style="width:${Math.min(100, m.usedPct)}%"></i></div>`
                  : `<div class="sub-chart-foot">Remaining: <strong>Uncapped</strong></div>`
              }
            </div>
          </div>

          <!-- Column 2: Validity & Expiry Pie Chart -->
          <div class="sub-chart-box" data-act="view-sub" data-id="${sub.id}" title="Click to inspect subscription lifecycle & expiry settings">
            <div class="sub-pie-wrap">
              ${expiryPieSvg}
            </div>
            <div class="sub-chart-info">
              <div class="sub-chart-kicker">Validity & Sync Lifecycle</div>
              <div class="sub-chart-headline">
                <strong>${
                  m.expireTs
                    ? m.isExpired
                      ? 'Expired'
                      : `${new Date(m.expireTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : 'No Expiration'
                }</strong>
                <span>${
                  m.expireTs
                    ? m.isExpired
                      ? `(${Math.abs(m.daysLeft)}d ago)`
                      : `(${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} left)`
                    : '· Lifetime Feed'
                }</span>
              </div>
              <div class="sub-chart-legend">
                <span class="sub-leg-item"><i style="background:#00A896"></i>Synced ${formatRelativeSync(sub.updatedAt)}</span>
                <span class="sub-leg-item"><i style="background:#94A3B8"></i>${new Date(sub.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div class="sub-chart-foot">
                Status: <strong>${m.isExpired ? 'Renewal required' : m.isExpiringSoon ? 'Expiring soon' : 'Healthy & synced'}</strong>
              </div>
            </div>
          </div>

          <!-- Column 3: Node Fleet Summary & Quick Preview -->
          <div class="sub-fleet-box">
            <div class="sub-fleet-head">
              <div>
                <div class="sub-chart-kicker">Included Server Fleet</div>
                <div class="sub-fleet-count num">
                  <strong>${m.nodeCount} ${m.nodeCount === 1 ? 'Server' : 'Servers'}</strong>
                  <span>· ${m.vlessCount} VLESS${m.vmessCount ? `, ${m.vmessCount} VMess` : ''}</span>
                </div>
              </div>
              ${
                m.fastestNode
                  ? `<span class="sub-fast-badge num" title="Fastest node: ${escapeHtml(m.fastestNode.name)}">${icon('zap', 12)}${m.fastestNode.ping} ms</span>`
                  : ''
              }
            </div>

            <div class="sub-node-pills">
              ${
                previewNodes.length
                  ? previewNodes
                      .map((n) => {
                        const isSel = n.id === store.status?.activeServerId;
                        const tone = latencyTone(n.ping);
                        return `<button type="button" class="sub-node-pill ${isSel ? 'is-selected' : ''}" data-act="quick-connect" data-id="${n.id}" title="Click to connect via ${escapeHtml(n.name)}">
                          ${flagHtml(n.geo?.countryCode, 18)}
                          <span class="sub-node-pill-name">${escapeHtml(n.name)}</span>
                          <span class="sub-node-pill-ping num tone-${tone}" title="${escapeHtml(latencyTitle(n))}">${latencyText(n.ping, n.pingStatus)}</span>
                        </button>`;
                      })
                      .join('')
                  : '<span class="tone-none" style="font-size:12px">Sync subscription to load server nodes</span>'
              }
              ${
                m.subNodes.length > 3
                  ? `<button type="button" class="sub-node-more" data-act="view-sub" data-id="${sub.id}">+${m.subNodes.length - 3} more nodes →</button>`
                  : ''
              }
            </div>
          </div>
        </div>
      </article>`;
    })
    .join('');

  root.innerHTML = `<div class="page sub-page">
    ${pageHead(
      'Subscriptions & Provider Feeds',
      'Sync remote VLESS & VMess provider feeds, visualize bandwidth quotas with real-time pie charts, track expiration dates, and inspect server fleets.',
      `<div class="srv-head-actions">
        <button type="button" class="btn" data-act="scan-qr">${icon('qr', 16)}Scan QR Code</button>
        ${subs.length ? `<button type="button" class="btn btn-primary" data-act="sync-all-subs">${icon('refresh', 16)}Sync All Feeds (${subs.length})</button>` : ''}
      </div>`
    )}

    <!-- 4-Card Subscription Telemetry KPI Strip -->
    <div class="srv-kpi-grid">
      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon is-teal">${icon('rss', 17)}</span>
          <span class="srv-kpi-label">Active Subscriptions</span>
        </div>
        <div class="srv-kpi-val num">${totalSubs} <small>${totalSubs === 1 ? 'Provider' : 'Providers'}</small></div>
        <div class="srv-kpi-foot">
          <span><strong>${totalSubNodes}</strong> Synced Nodes</span>
          <span class="srv-dot-sep">·</span>
          <span class="tone-good"><strong>${subs.filter((s) => s.enabled !== false).length}</strong> Enabled</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('pieChart', 17)}</span>
          <span class="srv-kpi-label">Combined Sub Traffic</span>
        </div>
        <div class="srv-kpi-val num">${formatBytes(totalUsedAll)}</div>
        <div class="srv-kpi-foot num">
          <span>↓ ${formatBytes(totalDownAll)}</span>
          <span class="srv-dot-sep">·</span>
          <span>↑ ${formatBytes(totalUpAll)}</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('chart', 17)}</span>
          <span class="srv-kpi-label">Quota Allocation</span>
        </div>
        <div class="srv-kpi-val num">
          ${
            totalQuotaAll > 0
              ? `${Math.min(100, Math.round((totalUsedAll / totalQuotaAll) * 100))}% <small>of ${formatBytes(totalQuotaAll)}</small>`
              : 'Unlimited'
          }
        </div>
        <div class="srv-kpi-foot">
          <span>${
            totalQuotaAll > 0
              ? `${formatBytes(Math.max(0, totalQuotaAll - totalUsedAll))} remaining across feeds`
              : 'No provider data cap enforced'
          }</span>
        </div>
      </section>

      <section class="panel srv-kpi-card">
        <div class="srv-kpi-top">
          <span class="srv-kpi-icon">${icon('calendar', 17)}</span>
          <span class="srv-kpi-label">Next Renewal / Sync</span>
        </div>
        <div class="srv-kpi-val num">
          ${
            nearestExpiry
              ? nearestExpiry.m.isExpired
                ? '<span class="tone-bad">Expired</span>'
                : `${Math.max(0, nearestExpiry.m.daysLeft)} <small>days left</small>`
              : subs.length
                ? 'Lifetime'
                : '—'
          }
        </div>
        <div class="srv-kpi-foot">
          <span>${
            nearestExpiry
              ? `${escapeHtml(nearestExpiry.sub.name)} · ${new Date(nearestExpiry.m.expireTs).toLocaleDateString()}`
              : latestSyncTs
                ? `Last synced ${formatRelativeSync(latestSyncTs)}`
                : 'Add a feed URL below'
          }</span>
        </div>
      </section>
    </div>

    <!-- Add Subscription Studio Panel -->
    <section class="panel srv-import-panel">
      <div class="srv-import-head">
        <div>
          <div class="section-title">Add Remote Subscription Feed</div>
          <div class="section-desc">Connect a provider subscription URL to automatically sync VLESS/VMess nodes, bandwidth usage headers, and expiration dates.</div>
        </div>
        <div class="srv-proto-pills" aria-hidden="true">
          <span>Base64 Feed</span><span>Subscription-Userinfo</span><span>Quota & Expiry</span><span>Auto-Sync</span>
        </div>
      </div>

      <div class="srv-import-bar sub-add-bar">
        <label class="field sub-label-field">
          ${icon('rss', 16)}
          <input data-ref="subName" placeholder="Label (e.g. Dialog Router, Work VPS)" aria-label="Subscription label" />
        </label>
        <label class="field srv-import-field">
          ${icon('link', 16)}
          <input data-ref="subUrl" placeholder="https://provider.example/sub/…" aria-label="Subscription URL" />
        </label>
        <button type="button" class="btn" data-act="paste-sub-url" title="Paste subscription URL from clipboard">${icon('clipboard', 16)}Paste URL</button>
        <button type="button" class="btn" data-act="scan-qr" title="Scan subscription QR code">${icon('qr', 16)}Scan QR</button>
        <button type="button" class="btn btn-primary srv-import-submit" data-act="add-sub">${icon('plus', 16)}Add Feed</button>
      </div>
    </section>

    <!-- Subscriptions Directory -->
    <section class="sub-list-section">
      ${
        subs.length
          ? `<div class="sub-cards-stack">${cardsHtml}</div>`
          : `<section class="panel section">${emptyState('rss', 'No subscriptions configured yet', 'Enter a subscription URL above or scan a provider QR code to sync servers and track data quota.')}</section>`
      }
    </section>
  </div>`;
}

/**
 * Opens the studio Subscription Inspector & Pie Chart Analytics Modal for a specific subscription.
 */
export function openSubscriptionModal({ subId, store, api, actions }) {
  const root = document.getElementById('modal-root');
  if (!root) return;

  function renderModal() {
    const sub = (store.data.subscriptions || []).find((s) => s.id === subId);
    if (!sub) {
      root.innerHTML = '';
      return;
    }

    const m = computeSubMetrics(sub, store);
    const hostLabel = extractHost(sub.url);
    const perServerUsage = store.data.usageHistory?.perServer || {};

    // Modal Pie Chart 1: Detailed Bandwidth & Quota Pie Chart (132px)
    const usageSlices = m.hasQuota
      ? [
          { value: Math.max(m.downBytes, 1), color: '#00A896', label: `Download: ${formatBytes(m.downBytes)}` },
          { value: Math.max(m.upBytes, 0), color: '#0F2942', label: `Upload: ${formatBytes(m.upBytes)}` },
          { value: Math.max(m.remainingBytes, 0), color: '#E6EEF4', label: `Remaining: ${formatBytes(m.remainingBytes)}` },
        ]
      : m.usedBytes > 0
        ? [
            { value: Math.max(m.downBytes, 1), color: '#00A896', label: `Download: ${formatBytes(m.downBytes)} (${m.dlSharePct}%)` },
            { value: Math.max(m.upBytes, Math.round(m.usedBytes * 0.04)), color: '#2563EB', label: `Upload: ${formatBytes(m.upBytes)} (${m.ulSharePct}%)` },
          ]
        : [{ value: 1, color: '#CBD5E1', label: 'No traffic recorded yet' }];

    const modalUsagePie = renderStudioPieSvg({
      size: 118,
      innerRatio: 0.58,
      slices: usageSlices,
      centerTop: m.hasQuota ? `${Math.round(m.usedPct)}%` : formatBytes(m.usedBytes),
      centerSub: m.hasQuota ? 'OF QUOTA' : 'TOTAL USED',
    });

    // Modal Pie Chart 2: Validity & Billing Cycle Pie Chart (118px)
    const expirySlices = m.expireTs
      ? m.isExpired
        ? [{ value: 1, color: '#D64545', label: 'Subscription Expired' }]
        : [
            {
              value: Math.max(1, m.remainingDaysClamped),
              color: m.isExpiringSoon ? '#D9822B' : '#00A896',
              label: `Remaining: ${Math.max(0, m.daysLeft)} days`,
            },
            {
              value: Math.max(0, m.elapsedDaysClamped),
              color: '#E6EEF4',
              label: `Elapsed: ${m.elapsedDaysClamped} days`,
            },
          ]
      : [
          { value: 85, color: '#00A896', label: 'Lifetime / No Expiration Set' },
          { value: 15, color: '#CCFBF1', label: 'Active Sync Cycle' },
        ];

    const modalExpiryPie = renderStudioPieSvg({
      size: 118,
      innerRatio: 0.54,
      slices: expirySlices,
      centerTop: m.expireTs ? (m.isExpired ? 'EXP' : `${Math.max(0, m.daysLeft)}d`) : '∞',
      centerSub: m.expireTs ? 'REMAINING' : 'NO EXPIRY',
    });

    // Modal Pie Chart 3: Node Fleet Health & Latency Pie Chart (118px)
    const fleetSlices =
      m.subNodes.length > 0
        ? [
            { value: m.optimalNodes.length, color: '#00A896', label: `Optimal (<120ms): ${m.optimalNodes.length}` },
            { value: m.fairNodes.length, color: '#D9822B', label: `Moderate (≥120ms): ${m.fairNodes.length}` },
            { value: m.untestedOrOfflineNodes.length, color: '#94A3B8', label: `Untested / Offline: ${m.untestedOrOfflineNodes.length}` },
          ]
        : [{ value: 1, color: '#E2E8F0', label: 'No nodes' }];

    const modalFleetPie = renderStudioPieSvg({
      size: 118,
      innerRatio: 0.56,
      slices: fleetSlices,
      centerTop: m.avgPing !== null ? `${m.avgPing}ms` : `${m.nodeCount}`,
      centerSub: m.avgPing !== null ? 'AVG PING' : 'NODES',
    });

    const expireDateVal = m.expireTs ? new Date(m.expireTs).toISOString().slice(0, 10) : '';
    const customGbVal = m.hasQuota ? Math.round((m.totalBytes / (1024 * 1024 * 1024)) * 10) / 10 : '';

    const nodeRowsHtml = m.subNodes
      .map((s) => {
        const selected = s.id === store.status?.activeServerId;
        const live = selected && connState(store.status) === 'connected';
        const tone = latencyTone(s.ping);
        const rec = perServerUsage[s.id];
        const nodeUsed = (rec?.downBytes || 0) + (rec?.upBytes || 0);
        const sniOrHost = s.sni || s.host || 'Default';

        return `
        <div class="sub-modal-node ${selected ? 'is-selected' : ''} ${live ? 'is-live' : ''}">
          <div class="sub-modal-node-main">
            ${flagHtml(s.geo?.countryCode, 34)}
            <div class="sub-modal-node-info">
              <div class="srv-name-row">
                <strong class="srv-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</strong>
                ${live ? '<span class="srv-status-pill is-live"><span class="status-dot is-on"></span>Connected</span>' : selected ? '<span class="srv-status-pill is-selected">Active</span>' : ''}
                <span class="tag ${s.protocol === 'vless' ? 'is-accent' : ''}">${escapeHtml(s.protocol)}</span>
                <span class="tag">${escapeHtml(s.network)}</span>
                ${s.security !== 'none' ? `<span class="tag">${escapeHtml(s.security)}</span>` : ''}
              </div>
              <div class="srv-endpoint mono" title="${escapeHtml(s.address)}:${s.port} · SNI: ${escapeHtml(sniOrHost)}">
                ${escapeHtml(s.address)}<span>:${s.port}</span> · SNI: <strong>${escapeHtml(sniOrHost)}</strong>
              </div>
            </div>
          </div>

          <div class="sub-modal-node-right">
            <div class="sub-modal-node-usage num">
              ${nodeUsed > 0 ? `↓ ${formatBytes(rec.downBytes || 0)} · ↑ ${formatBytes(rec.upBytes || 0)}` : '<span class="tone-none">0 B local</span>'}
            </div>

            <div class="srv-ping-box" data-tone="${tone}" title="${escapeHtml(latencyTitle(s))}">
              <span class="srv-ping-val num tone-${tone}">${latencyText(s.ping, s.pingStatus)}</span>
              <span class="signal" data-tone="${tone}" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>

            <button type="button" class="btn btn-sm ${live ? 'is-selected-chip' : selected ? 'btn-primary' : ''}" data-sub-act="connect-node" data-id="${s.id}">
              ${icon('power', 13)}<span>${live ? 'Disconnect' : 'Connect'}</span>
            </button>

            <div class="srv-action-dock">
              <button type="button" class="srv-dock-btn" data-sub-act="ping-node" data-id="${s.id}" title="Measure direct TCP latency" ${s.pingStatus === 'measuring' ? 'disabled' : ''}>${icon('gauge', 14)}</button>
              <button type="button" class="srv-dock-btn" data-sub-act="qr-node" data-id="${s.id}" title="Show QR Code">${icon('qr', 14)}</button>
              <button type="button" class="srv-dock-btn" data-sub-act="edit-node" data-id="${s.id}" title="Edit Server">${icon('pencil', 14)}</button>
              <button type="button" class="srv-dock-btn" data-sub-act="copy-node" data-id="${s.id}" title="Copy Share URI">${icon('copy', 14)}</button>
            </div>
          </div>
        </div>`;
      })
      .join('');

    root.innerHTML = `
    <div class="modal sub-modal-backdrop" data-sub-act="backdrop">
      <div class="panel modal-box sub-modal-box" role="dialog" aria-modal="true" aria-label="Subscription Details">
        <!-- Modal Header -->
        <div class="sub-modal-head">
          <div class="sub-modal-title-group">
            <div class="sub-avatar is-lg">${icon('rss', 22)}</div>
            <div>
              <div class="sub-title-row">
                <h2>${escapeHtml(sub.name)}</h2>
                <span class="sub-host-pill mono">${escapeHtml(hostLabel)}</span>
              </div>
              <p class="sub-modal-subtitle">
                Synced ${new Date(sub.updatedAt).toLocaleString()} (${formatRelativeSync(sub.updatedAt)}) · ${m.nodeCount} ${m.nodeCount === 1 ? 'server node' : 'server nodes'}
              </p>
            </div>
          </div>

          <div class="sub-modal-head-actions">
            <button type="button" class="btn btn-sm" data-sub-act="ping-all">${icon('gauge', 15)}Benchmark Nodes</button>
            <button type="button" class="btn btn-sm" data-sub-act="sync-now">${icon('refresh', 15)}Sync Feed</button>
            <button type="button" class="btn btn-sm" data-sub-act="copy-url">${icon('copy', 15)}Copy URL</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-sub-act="close" aria-label="Close">${icon('x', 18)}</button>
          </div>
        </div>

        <!-- Scrollable Modal Content -->
        <div class="sub-modal-body">
          <!-- 3-Column Studio Pie Charts Grid -->
          <div class="sub-modal-charts-grid">
            <!-- Pie Card 1: Bandwidth & Quota -->
            <section class="sub-modal-chart-card">
              <div class="sub-modal-chart-top">
                <span class="sub-modal-chart-title">${icon('pieChart', 15)}Data Usage & Quota Split</span>
                <span class="tag ${m.hasQuota ? 'is-accent' : ''}">${m.hasQuota ? `${m.usedPct}% Used` : 'Unlimited'}</span>
              </div>
              <div class="sub-modal-chart-main">
                ${modalUsagePie}
                <div class="sub-modal-stat-list num">
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#00A896"></i>Download</span>
                    <strong>${formatBytes(m.downBytes)} (${m.dlSharePct}%)</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:${m.hasQuota ? '#0F2942' : '#2563EB'}"></i>Upload</span>
                    <strong>${formatBytes(m.upBytes)} (${m.ulSharePct}%)</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#CBD5E1"></i>Remaining</span>
                    <strong>${m.hasQuota ? formatBytes(m.remainingBytes) : 'Uncapped'}</strong>
                  </div>
                  <div class="sub-modal-stat-row is-total">
                    <span>Total Consumed</span>
                    <strong>${formatBytes(m.usedBytes)}${m.hasQuota ? ` / ${formatBytes(m.totalBytes)}` : ''}</strong>
                  </div>
                </div>
              </div>
            </section>

            <!-- Pie Card 2: Expiration & Lifecycle -->
            <section class="sub-modal-chart-card">
              <div class="sub-modal-chart-top">
                <span class="sub-modal-chart-title">${icon('calendar', 15)}Expiry & Billing Timeline</span>
                <span class="tag ${m.isExpired ? 'is-warn' : 'is-accent'}">${
                  m.expireTs ? (m.isExpired ? 'Expired' : `${m.daysLeft}d Remaining`) : 'No Expiry'
                }</span>
              </div>
              <div class="sub-modal-chart-main">
                ${modalExpiryPie}
                <div class="sub-modal-stat-list num">
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#00A896"></i>Expiry Date</span>
                    <strong>${m.expireTs ? new Date(m.expireTs).toLocaleDateString() : 'Never Expires'}</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#94A3B8"></i>Last Synced</span>
                    <strong>${new Date(sub.updatedAt).toLocaleDateString()}</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#38BDF8"></i>Local Sessions</span>
                    <strong>${m.localSessions} sessions</strong>
                  </div>
                  <div class="sub-modal-stat-row is-total">
                    <span>Connected Time</span>
                    <strong>${formatDuration((m.localConnectedSeconds || 0) * 1000)}</strong>
                  </div>
                </div>
              </div>
            </section>

            <!-- Pie Card 3: Node Fleet Health & Latency -->
            <section class="sub-modal-chart-card">
              <div class="sub-modal-chart-top">
                <span class="sub-modal-chart-title">${icon('server', 15)}Node Fleet Health & Ping</span>
                <span class="tag is-accent">${m.reachableNodes.length}/${m.nodeCount} Online</span>
              </div>
              <div class="sub-modal-chart-main">
                ${modalFleetPie}
                <div class="sub-modal-stat-list num">
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#00A896"></i>Optimal (&lt;120ms)</span>
                    <strong>${m.optimalNodes.length} nodes</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#D9822B"></i>Moderate</span>
                    <strong>${m.fairNodes.length} nodes</strong>
                  </div>
                  <div class="sub-modal-stat-row">
                    <span><i style="background:#94A3B8"></i>Untested / Timeout</span>
                    <strong>${m.untestedOrOfflineNodes.length} nodes</strong>
                  </div>
                  <div class="sub-modal-stat-row is-total">
                    <span>Fastest Route</span>
                    <strong>${m.fastestNode ? `${m.fastestNode.ping} ms (${escapeHtml(m.fastestNode.geo?.countryCode || 'OK')})` : 'Run Benchmark'}</strong>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- Included Server Nodes List -->
          <div class="sub-modal-section">
            <div class="sub-modal-sec-head">
              <div>
                <h4>Subscription Server Nodes (${m.nodeCount})</h4>
                <p>Connect directly, inspect QR passes, or customize SNI/Bug Host parameters for any node in this feed.</p>
              </div>
            </div>
            <div class="sub-modal-nodes-list">
              ${nodeRowsHtml || '<p class="tone-none">No server nodes found in this subscription.</p>'}
            </div>
          </div>

          <!-- Custom Quota, Expiry & Feed Settings -->
          <div class="sub-modal-section sub-modal-settings">
            <div class="sub-modal-sec-head">
              <div>
                <h4>Feed Configuration & Custom Quota / Expiry Override</h4>
                <p>If your VPS provider does not send <code>Subscription-Userinfo</code> headers, you can set your plan's data cap and renewal date manually below.</p>
              </div>
            </div>
            <div class="sub-modal-form-grid">
              <label class="form-field">
                <span class="form-label">Subscription Label</span>
                <div class="field"><input data-sub-ref="name" value="${escapeHtml(sub.name)}" placeholder="Subscription name" /></div>
              </label>
              <label class="form-field">
                <span class="form-label">Plan Data Quota (GB, leave blank for Unlimited)</span>
                <div class="field"><input data-sub-ref="quotaGb" type="number" min="0" step="0.5" value="${customGbVal}" placeholder="e.g. 100" /></div>
              </label>
              <label class="form-field">
                <span class="form-label">Expiration / Renewal Date (optional)</span>
                <div class="field"><input data-sub-ref="expireDate" type="date" value="${expireDateVal}" /></div>
              </label>
              <label class="form-field">
                <span class="form-label">Feed URL</span>
                <div class="field"><input class="mono" data-sub-ref="url" value="${escapeHtml(sub.url)}" /></div>
              </label>
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="modal-foot sub-modal-foot">
          <span class="sub-modal-foot-hint">Changes to label, quota cap, or expiry date update charts immediately.</span>
          <div class="row">
            <button type="button" class="btn" data-sub-act="close">Close</button>
            <button type="button" class="btn btn-primary" data-sub-act="save-settings">${icon('check', 15)}Save Subscription Settings</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  renderModal();

  root.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.matches?.('[data-sub-ref]')) {
      e.preventDefault();
      root.querySelector('[data-sub-act="save-settings"]')?.click();
    }
  };

  root.onclick = async (e) => {
    const trigger = e.target.closest('[data-sub-act]');
    if (!trigger) return;
    const act = trigger.dataset.subAct;
    const nodeId = trigger.dataset.id;
    const sub = (store.data.subscriptions || []).find((s) => s.id === subId);
    if (!sub) return;

    if (act === 'backdrop' && e.target !== trigger) return;
    if (act === 'close' || act === 'backdrop') {
      root.innerHTML = '';
      return;
    }
    if (act === 'copy-url') {
      return copyText(sub.url, 'Subscription URL copied');
    }
    if (act === 'sync-now') {
      trigger.disabled = true;
      const res = await api('/api/refresh-subscription', { subId });
      trigger.disabled = false;
      toast(res.ok ? `Synced · ${res.count} servers` : res.error || 'Sync failed', res.ok ? 'success' : 'error');
      return renderModal();
    }
    if (act === 'ping-all') {
      trigger.disabled = true;
      await api('/api/ping-subscription', { subId });
      trigger.disabled = false;
      toast('Measured latency for all subscription nodes', 'success');
      return renderModal();
    }
    if (act === 'save-settings') {
      const name = root.querySelector('[data-sub-ref="name"]')?.value.trim();
      const url = root.querySelector('[data-sub-ref="url"]')?.value.trim();
      const quotaGbRaw = root.querySelector('[data-sub-ref="quotaGb"]')?.value.trim();
      const expireDateRaw = root.querySelector('[data-sub-ref="expireDate"]')?.value.trim();

      const totalBytes = quotaGbRaw && Number(quotaGbRaw) > 0 ? Math.round(Number(quotaGbRaw) * 1024 * 1024 * 1024) : 0;
      const expireTimestamp = expireDateRaw ? new Date(`${expireDateRaw}T23:59:59`).getTime() : 0;

      if (name) sub.name = name;
      if (url && url.startsWith('http')) sub.url = url;
      sub.totalBytes = totalBytes > 0 ? totalBytes : undefined;
      sub.expireTimestamp = expireTimestamp > 0 ? expireTimestamp : undefined;

      trigger.disabled = true;
      try {
        const res = await api('/api/update-subscription', {
          subId,
          name,
          url,
          totalBytes,
          expireTimestamp,
        });
        if (res && res.subscription) {
          Object.assign(sub, res.subscription);
        }
      } catch {
        /* local state updated */
      }
      root.innerHTML = '';
      const subView = document.getElementById('view-subscriptions');
      if (subView && !subView.hidden) {
        renderSubscriptions(subView, store);
      }
      toast('Subscription settings saved', 'success');
      return;
    }
    if (act === 'connect-node' && nodeId) {
      const conn = connState(store.status);
      if (nodeId === store.status?.activeServerId && conn === 'connected') {
        await api('/api/disconnect', {});
      } else {
        if (nodeId !== store.status?.activeServerId) await actions.selectServer(nodeId);
        if (!store.status?.connected) await actions.connect();
      }
      setTimeout(renderModal, 180);
      return;
    }
    if (act === 'ping-node' && nodeId) {
      await actions.pingServer(nodeId, trigger);
      return renderModal();
    }
    if (act === 'qr-node' && nodeId) {
      return actions.showQr(nodeId);
    }
    if (act === 'edit-node' && nodeId) {
      return actions.editServer(nodeId, () => renderModal());
    }
    if (act === 'copy-node' && nodeId) {
      const node = store.data.servers.find((s) => s.id === nodeId);
      if (node) copyText(node.rawUri, 'Share link copied');
    }
  };
}

// ---------------------------------------------------------------- Settings

export function renderSettings(root, store) {
  const st = store.status;
  const d = store.data;
  const linux = st.platform === 'linux';
  const tunAvailable = Boolean(st.tunCapability?.available);
  const isDark = (d.theme || document.documentElement.dataset.theme || 'light') === 'dark';
  const cmds = store.terminalCommands || {};
  const sw = (act, on, label) => `<button class="switch" role="switch" aria-checked="${on}" aria-label="${label}" data-act="${act}"></button>`;
  const cmdRows = [
    ['PowerShell', cmds.powershell],
    ['Command Prompt', cmds.cmd],
    ['Git (global)', cmds.git],
    ['npm (global)', cmds.npm],
  ]
    .filter(([, c]) => c)
    .map(
      ([label, c]) => `<div class="cmd"><span class="cmd-label">${label}</span><code class="cmd-code" title="${escapeHtml(c)}">${escapeHtml(c)}</code><button class="btn btn-ghost btn-icon btn-sm" data-act="copy-cmd" data-cmd="${escapeHtml(c)}" title="Copy">${icon('copy', 15)}</button></div>`
    )
    .join('');

  root.innerHTML = `<div class="page">
    ${pageHead('Settings', 'Customize appearance, choose how traffic reaches the tunnel, and adjust local proxy behaviour.')}
    <section class="panel section">
      <div class="section-title">Appearance &amp; Theme</div>
      <div class="setting">
        <div class="setting-text">
          <strong>System-wide dark theme</strong>
          <span>Switch the entire application — including the interactive world map, telemetry charts, Shield studio, and modals — between crisp daylight and low-glare dark mode.</span>
        </div>
        <div class="row" style="gap:14px">
          <div class="segmented" role="group" aria-label="Theme mode">
            <button type="button" data-act="set-theme" data-theme="light" aria-pressed="${!isDark}">${icon('sun', 15)}Light</button>
            <button type="button" data-act="set-theme" data-theme="dark" aria-pressed="${isDark}">${icon('moon', 15)}Dark</button>
          </div>
          ${sw('toggle-theme', isDark, 'System-wide dark theme')}
        </div>
      </div>
    </section>
    <section class="panel section">
      <div class="section-title">Traffic routing</div>
      <div class="setting">
        <div class="setting-text"><strong>Routing mode</strong><span>${linux ? 'Local proxy exposes loopback HTTP/SOCKS ports. Linux TUN captures IPv4 device traffic after polkit authorization and refuses dual-stack hosts until IPv6 protection is implemented.' : 'System proxy covers browsers and most apps. Full TUN creates a virtual adapter so every app — including terminal tools — uses the tunnel.'}</span></div>
        <div class="segmented" role="group" aria-label="Routing mode">
          <button data-act="mode" data-mode="system_proxy" aria-pressed="${st.routingMode === 'system_proxy'}">${icon('globe', 15)}${linux ? 'Local proxy' : 'System proxy'}</button>
          <button data-act="mode" data-mode="tun" aria-pressed="${st.routingMode === 'tun'}" ${linux && !tunAvailable ? 'disabled' : ''} title="${linux && !tunAvailable ? escapeHtml(st.tunCapability?.reason || 'Linux TUN unavailable') : ''}">${icon('terminal', 15)}${linux ? 'Linux TUN' : 'Full TUN'}</button>
        </div>
      </div>
      <div class="setting">
        <div class="setting-text"><strong>${linux ? 'Linux network helper' : 'Administrator access'}</strong><span>${linux ? 'The root-owned package helper requests polkit authorization only while creating and restoring the TUN interface and routes.' : 'Full TUN mode needs administrator rights to create the Wintun adapter and routes.'}</span></div>
        ${linux
          ? (tunAvailable
            ? `<div class="notice notice-ok">${icon('shieldCheck', 16)}Installed · polkit authorization requested on connect</div>`
            : `<div class="notice notice-warn">${icon('alert', 16)}${escapeHtml(st.tunCapability?.reason || 'Linux TUN unavailable')}</div>`)
          : (st.isAdmin
            ? `<div class="notice notice-ok">${icon('shieldCheck', 16)}Running as administrator</div>`
            : `<button class="btn" data-act="elevate">${icon('shield', 16)}Restart as administrator</button>`)}
      </div>
      <div class="setting">
        <div class="setting-text"><strong>Terminal proxy variables</strong><span>Sets HTTP_PROXY, HTTPS_PROXY and ALL_PROXY for your user so new terminals route npm, git, pip and curl through the tunnel without TUN.</span></div>
        ${sw('terminal-env', !!st.terminalEnvActive, 'Terminal proxy variables')}
      </div>
      <div class="setting">
        <div class="setting-text">
          <strong>Smart Split Tunneling (Per-App &amp; Per-Site Routing)</strong>
          <span>Choose specific websites, app groups (.lk banking, Steam, Netflix, Discord), or IP subnets to bypass the VPN (Direct ISP) or route exclusively through the VPN.</span>
        </div>
        <button class="btn" data-act="open-split">${icon('route', 15)}Configure Split Tunneling</button>
      </div>
    </section>
    <section class="panel section">
      <div class="section-title">Connection</div>
      <div class="setting">
        <div class="setting-text"><strong>Connection multiplexing (Xray Mux)</strong><span>Packs multiple streams into shared TCP connections. Leave off for faster parallel browser page loading; enable only if your server restricts concurrent TCP connections.</span></div>
        ${sw('mux-enabled', !!d.muxEnabled, 'Connection multiplexing')}
      </div>
      <div class="setting">
        <div class="setting-text"><strong>Bypass local networks</strong><span>Keep LAN and private ranges (192.168.x.x, 10.x.x.x…) outside the tunnel.</span></div>
        ${sw('bypass-lan', !!d.bypassLan, 'Bypass local networks')}
      </div>
      <div class="setting">
        <div class="setting-text"><strong>Allow insecure TLS certificates</strong><span>Compatibility for legacy servers requiring allowInsecure=true. Trusts and pins each server's certificate when connecting, including self-signed or mismatched certificates. For an individual profile, use Allow insecure certificate in Edit server.</span></div>
        ${sw('allow-insecure', !!d.allowInsecureDefault, 'Allow insecure TLS')}
      </div>
      <div class="setting">
        <div class="setting-text"><strong>Local proxy ports</strong><span>Ports used by the local SOCKS5 and HTTP inbounds.</span></div>
        <div class="row">
          <label class="field" style="width:120px"><span style="font-size:11px">SOCKS</span><input data-ref="socksPort" type="number" min="1025" max="65535" value="${d.socksPort}" aria-label="SOCKS port" /></label>
          <label class="field" style="width:120px"><span style="font-size:11px">HTTP</span><input data-ref="httpPort" type="number" min="1025" max="65535" value="${d.httpPort}" aria-label="HTTP port" /></label>
          <button class="btn" data-act="save-ports">Save</button>
        </div>
      </div>
      <div class="setting">
        <div class="setting-text"><strong>Welcome & feature tour</strong><span>Replay the interactive 5-step onboarding guide showcasing DragonForce Vpn features.</span></div>
        <button class="btn" data-act="open-onboarding">${icon('shield', 15)}Replay welcome tour</button>
      </div>
    </section>
    <section class="panel section">
      <div class="section-title">Terminal commands</div>
      <div class="section-desc">For terminals that are already open. Copy and run once per session.</div>
      <div style="margin-top:8px">${cmdRows}</div>
    </section>
    <section class="panel section about-section" id="about-dragonforce">
      <div class="about-hero">
        <div class="about-brand-left">
          <div class="about-logo-box">${brandMark(52)}</div>
          <div class="about-brand-copy">
            <div class="about-title-row">
              <h2 class="about-app-name">${escapeHtml(APP_RELEASE_INFO.name)}</h2>
              <span class="about-version-pill">${escapeHtml(APP_RELEASE_INFO.version)}</span>
              <span class="about-channel-pill">${escapeHtml(APP_RELEASE_INFO.channel)}</span>
            </div>
            <p class="about-tagline">${escapeHtml(APP_RELEASE_INFO.tagline)}</p>
            <div class="about-spec-row">
              <span class="about-spec-chip">${icon('zap', 12)} ${escapeHtml(APP_RELEASE_INFO.coreEngine)}</span>
              <span class="about-spec-chip">${icon('monitor', 12)} ${escapeHtml(APP_RELEASE_INFO.buildTarget)}</span>
              <span class="about-spec-chip">${icon('shieldCheck', 12)} Build ${escapeHtml(APP_RELEASE_INFO.buildDate)}</span>
            </div>
          </div>
        </div>
        <div class="about-hero-actions">
          <a
            href="${escapeHtml(APP_RELEASE_INFO.githubReleasesUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary btn-sm about-ext-btn"
          >
            ${icon('github', 15)}
            <span>GitHub Releases</span>
            ${icon('externalLink', 13)}
          </a>
          <button
            type="button"
            class="btn btn-sm"
            data-act="copy-cmd"
            data-cmd="${escapeHtml(`${APP_RELEASE_INFO.name} ${APP_RELEASE_INFO.version} (${APP_RELEASE_INFO.coreEngine})`)}"
          >
            ${icon('copy', 14)}
            <span>Copy Version</span>
          </button>
        </div>
      </div>

      <div class="about-links-grid">
        <!-- 1. WhatsApp Direct Contact -->
        <div class="about-social-card">
          <div class="about-social-head">
            <span class="about-social-ico is-wa">${icon('whatsapp', 20)}</span>
            <div class="about-social-meta">
              <strong>WhatsApp Direct Contact</strong>
              <span class="mono">${escapeHtml(APP_RELEASE_INFO.whatsappNumber)} · +94 71 070 9140</span>
            </div>
          </div>
          <p class="about-social-desc">Direct developer contact for support, custom VLESS/VMess nodes, and feedback.</p>
          <div class="about-social-foot">
            <a
              href="${escapeHtml(APP_RELEASE_INFO.whatsappDirectUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-sm about-wa-btn"
            >
              ${icon('whatsapp', 14)}
              <span>Message ${escapeHtml(APP_RELEASE_INFO.whatsappNumber)}</span>
              ${icon('externalLink', 12)}
            </a>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              data-act="copy-cmd"
              data-cmd="${escapeHtml(APP_RELEASE_INFO.whatsappNumber)}"
              title="Copy WhatsApp number"
            >
              ${icon('copy', 13)}
              <span>Copy</span>
            </button>
          </div>
        </div>

        <!-- 2. WhatsApp Official Channel -->
        <div class="about-social-card">
          <div class="about-social-head">
            <span class="about-social-ico is-wa">${icon('whatsapp', 20)}</span>
            <div class="about-social-meta">
              <strong>Official WhatsApp Channel</strong>
              <span>DragonForce Vpn Community</span>
            </div>
          </div>
          <p class="about-social-desc">Follow the official WhatsApp Channel for new server feeds, SNI updates, and release alerts.</p>
          <div class="about-social-foot">
            <a
              href="${escapeHtml(APP_RELEASE_INFO.whatsappChannelUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-sm about-wa-btn"
            >
              ${icon('whatsapp', 14)}
              <span>Join WhatsApp Channel</span>
              ${icon('externalLink', 12)}
            </a>
          </div>
        </div>

        <!-- 3. GitHub Repository & Releases -->
        <div class="about-social-card">
          <div class="about-social-head">
            <span class="about-social-ico is-gh">${icon('github', 20)}</span>
            <div class="about-social-meta">
              <strong>GitHub Repository &amp; Releases</strong>
              <span>Open-Source Release Distribution</span>
            </div>
          </div>
          <p class="about-social-desc">Download official Windows x64 builds, inspect release changelogs, and report issues on GitHub.</p>
          <div class="about-social-foot">
            <a
              href="${escapeHtml(APP_RELEASE_INFO.githubRepoUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-sm about-gh-btn"
            >
              ${icon('github', 14)}
              <span>Open GitHub Repo</span>
              ${icon('externalLink', 12)}
            </a>
            <a
              href="${escapeHtml(APP_RELEASE_INFO.githubReleasesUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost btn-sm about-ext-btn"
            >
              <span>Releases</span>
              ${icon('externalLink', 12)}
            </a>
          </div>
        </div>
      </div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- Logs

export function renderLogsShell(root, store) {
  const f = store.logFilter;
  root.innerHTML = `<div class="page">
    ${pageHead('Logs', 'Live output from the Xray core, the TUN adapter and the app.')}
    <div class="log-toolbar">
      <div class="segmented" role="group" aria-label="Filter logs">
        ${['all', 'xray', 'tun', 'system'].map((k) => `<button data-act="log-filter" data-filter="${k}" aria-pressed="${f === k}">${k === 'all' ? 'All' : k === 'tun' ? 'TUN' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
      </div>
      <button class="btn btn-sm" data-act="clear-logs">${icon('trash', 15)}Clear</button>
    </div>
    <div class="panel log-console" data-ref="logConsole"></div>
  </div>`;
  renderLogLines(root, store);
}

export function renderLogLines(root, store) {
  const box = root.querySelector('[data-ref="logConsole"]');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const lines = store.logs.filter((l) => store.logFilter === 'all' || l.source === store.logFilter);
  box.innerHTML = lines.length
    ? lines
        .map(
          (l) =>
            `<div class="log-line ${l.level}"><span class="log-time num">${new Date(l.timestamp).toLocaleTimeString([], { hour12: false })}</span><span class="log-src">${l.source}</span><span class="log-msg">${escapeHtml(l.message)}</span></div>`
        )
        .join('')
    : emptyState('logs', 'No log entries', 'Output appears here once the core starts.');
  if (atBottom) box.scrollTop = box.scrollHeight;
}
