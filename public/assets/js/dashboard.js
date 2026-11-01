import { WorldMap } from './world-map.js';
import { MAX_ZOOM, haversineKm } from './geo-math.js';
import { icon } from './icons.js';
import {
  drawSparkline,
  escapeHtml,
  flagHtml,
  formatBytes,
  formatDuration,
  latencyText,
  latencyTitle,
  latencyTone,
  locationLabel,
  splitBytes,
} from './ui.js';

const STATE_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  error: 'Connection failed',
  disconnected: 'Disconnected',
};

const EXIT_IP_GRACE_MS = 12000;
const ZOOM_TICKS = 8;

/** Derives the UI connection state from backend status flags. */
export function connState(status) {
  if (!status) return 'disconnected';
  if (status.connecting && status.connected) return 'reconnecting';
  if (status.connecting) return 'connecting';
  if (status.connected) return 'connected';
  if (status.lastError) return 'error';
  return 'disconnected';
}

function protocolText(node) {
  const sec = node.security === 'none' ? 'No TLS' : node.security.toUpperCase();
  return `${node.protocol.toUpperCase()} · ${node.network.toUpperCase()} · ${sec}`;
}

export function createDashboard(root, actions) {
  root.innerHTML = `
  <div class="dash" data-conn="disconnected">
    <aside class="panel locations" aria-label="Locations">
      <div class="locations-head">
        <h2>Locations<span class="count" data-ref="locCount"></span></h2>
        <button class="btn btn-ghost btn-icon btn-sm" data-ref="pingAll" data-act="ping-all" title="Measure direct TCP latency for all servers">${icon('gauge', 16)}</button>
      </div>
      <div class="locations-search">
        <label class="field field-muted">${icon('search', 16)}<input data-ref="search" type="search" placeholder="Search servers or countries" aria-label="Search servers" /></label>
      </div>
      <div class="loc-list" data-ref="locList" role="listbox" aria-label="Servers"></div>
      <div class="locations-foot"><button class="btn" data-act="add-server">${icon('plus', 16)}Add server</button><button class="btn" data-act="scan-qr" title="Scan QR code from screen or clipboard">${icon('qr', 16)}Scan QR</button></div>
    </aside>

    <section class="panel map-panel" aria-label="Network map">
      <div data-ref="stage"></div>
      <div class="map-top">
        <div class="map-title">
          <button class="btn btn-icon loc-toggle" data-act="toggle-locations" title="Show locations" aria-label="Show locations">${icon('panel', 16)}</button>
          <div><h2>Network map</h2><p data-ref="mapSub">Geographic view of your tunnel</p></div>
        </div>
        <div class="map-controls">
          <div class="ctrl-group">
            <button data-act="zoom-out" title="Zoom out" aria-label="Zoom out">${icon('minus', 16)}</button>
            <div class="zoom-ticks" data-ref="ticks" aria-hidden="true">${'<i></i>'.repeat(ZOOM_TICKS)}</div>
            <button data-act="zoom-in" title="Zoom in" aria-label="Zoom in">${icon('plus', 16)}</button>
          </div>
          <div class="ctrl-group">
            <button data-act="focus-route" title="Center on connection" aria-label="Center on connection">${icon('locate', 16)}</button>
            <button data-act="reset-map" title="Reset view" aria-label="Reset view">${icon('reset', 16)}</button>
          </div>
        </div>
      </div>
      <div class="map-bottom">
        <div class="route-summary" data-ref="route"></div>
        <p class="map-note">The arc links your location and the VPN server geographically — it is not the physical internet path.</p>
      </div>
    </section>

    <aside class="panel conn" aria-label="Connection">
      <div class="conn-head">
        <h2>Secure connection</h2>
        <div class="conn-state" role="status" aria-live="polite"><span class="status-dot"></span><strong data-ref="stateText">Disconnected</strong><span data-ref="stateSub"></span></div>
      </div>
      <div class="power-wrap">
        <button class="power" data-act="power" data-ref="power" aria-label="Connect">
          <span class="power-ring"></span>
          <span class="power-inner">${icon('power', 30)}<span class="power-label" data-ref="powerLabel">Connect</span></span>
        </button>
        <div class="timer" data-ref="timer">00:00:00</div>
        <div class="timer-caption" data-ref="timerCaption">Not connected</div>
      </div>
      <div class="conn-error" data-ref="error" hidden>${icon('alert', 16)}<p data-ref="errorText"></p><button class="btn btn-sm" data-act="retry">Retry</button></div>
      <div class="details" data-ref="details"></div>
      <div class="metrics">
        <div class="metric metric-down">
          <div class="metric-label"><span class="chip">${icon('arrowDown', 13)}</span>Download</div>
          <div class="metric-value" data-ref="downVal">0<small>B/s</small></div>
          <canvas data-ref="downSpark" aria-hidden="true"></canvas>
          <div class="metric-foot" data-ref="downFoot">Session 0 B</div>
        </div>
        <div class="metric metric-up">
          <div class="metric-label"><span class="chip">${icon('arrowUp', 13)}</span>Upload</div>
          <div class="metric-value" data-ref="upVal">0<small>B/s</small></div>
          <canvas data-ref="upSpark" aria-hidden="true"></canvas>
          <div class="metric-foot" data-ref="upFoot">Session 0 B</div>
        </div>
      </div>
    </aside>
  </div>`;

  const dash = root.querySelector('.dash');
  const ref = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
  const sigs = {};
  let search = '';
  let lastStore = null;

  const map = new WorldMap(ref.stage, {
    onSelect: (id) => actions.selectServer(id),
    onViewChange: (view) => {
      const on = Math.round((Math.log(view.k) / Math.log(MAX_ZOOM)) * (ZOOM_TICKS - 1)) + 1;
      ref.ticks.querySelectorAll('i').forEach((t, i) => t.classList.toggle('is-on', i < on));
    },
  });
  map.load('/assets/world-dots.json');

  // ---- events (delegated) ----
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const item = e.target.closest('.loc-item');
    if (item && !btn) {
      actions.selectServer(item.dataset.id);
      dash.classList.remove('show-locations');
      return;
    }
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'qr-server':
        actions.showQr(btn.dataset.id);
        break;
      case 'scan-qr':
        actions.scanQr();
        break;
      case 'edit-server':
        actions.editServer(btn.dataset.id);
        break;
      case 'delete-server':
        actions.deleteServer(btn.dataset.id, btn);
        break;
      case 'power':
        actions.togglePower();
        break;
      case 'retry':
        actions.connect();
        break;
      case 'ping-all':
        actions.pingAll(btn);
        break;
      case 'add-server':
        actions.navigate('servers');
        break;
      case 'toggle-locations':
        dash.classList.toggle('show-locations');
        break;
      case 'zoom-in':
        map.zoomBy(1.6);
        break;
      case 'zoom-out':
        map.zoomBy(1 / 1.6);
        break;
      case 'focus-route':
        map.focusRoute();
        break;
      case 'reset-map':
        map.resetView();
        break;
      case 'measure':
        actions.pingServer(btn.dataset.id, btn);
        break;
      case 'tunnel-test':
        actions.testTunnel(btn);
        break;
      case 'open-speed':
        actions.navigate('speed');
        break;
      case 'open-shield':
        actions.navigate('shield');
        break;
    }
  });
  ref.search.addEventListener('input', () => {
    search = ref.search.value.trim().toLowerCase();
    if (lastStore) renderLocations(lastStore, true);
  });
  ref.locList.addEventListener('keydown', (e) => {
    const item = e.target.closest('.loc-item');
    if (item && e.target === item && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      actions.selectServer(item.dataset.id);
    }
  });

  // ---- renderers ----
  function renderLocations(store, force = false) {
    const { servers } = store.data;
    const conn = connState(store.status);
    const activeId = store.status?.activeServerId;
    const measuring = servers.some((s) => s.pingStatus === 'measuring');
    ref.pingAll.disabled = measuring;
    ref.pingAll.classList.toggle('is-busy', measuring);
    ref.pingAll.setAttribute('aria-busy', String(measuring));
    const sig = JSON.stringify([search, activeId, conn, servers.map((s) => [s.id, s.name, s.ping, s.pingStatus, s.pingError, s.pingCheckedAt, s.geo?.countryCode, s.geo?.city])]);
    if (!force && sig === sigs.loc) return;
    sigs.loc = sig;
    ref.locCount.textContent = servers.length ? ` · ${servers.length}` : '';

    if (!servers.length) {
      ref.locList.innerHTML = `<div class="empty"><span class="empty-icon">${icon('server', 20)}</span><strong>No servers yet</strong><p>Import a vless:// or vmess:// link, or add a subscription.</p><button class="btn btn-primary btn-sm" data-act="add-server">${icon('plus', 15)}Add server</button></div>`;
      return;
    }
    const filtered = servers.filter((s) =>
      !search || [s.name, s.address, s.geo?.country, s.geo?.city].some((v) => v && v.toLowerCase().includes(search))
    );
    if (!filtered.length) {
      ref.locList.innerHTML = `<div class="empty"><span class="empty-icon">${icon('search', 20)}</span><strong>No matches</strong><p>No server matches “${escapeHtml(search)}”.</p></div>`;
      return;
    }
    ref.locList.innerHTML = filtered
      .map((s) => {
        const selected = s.id === activeId;
        const live = selected && conn === 'connected';
        const tone = latencyTone(s.ping);
        const where = s.geo ? locationLabel(s.geo) : s.address;
        return `<div class="loc-item${selected ? ' is-selected' : ''}" data-id="${s.id}" role="option" tabindex="0" aria-selected="${selected}">
          ${flagHtml(s.geo?.countryCode, 32)}
          <span style="min-width:0">
            <span class="loc-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
            <span class="loc-sub">${live ? '<span class="live">Connected</span>·' : ''}<span>${escapeHtml(where)}</span></span>
          </span>
          <span class="loc-meta" title="${escapeHtml(latencyTitle(s))}" aria-live="polite">
            <span class="num tone-${tone}">${latencyText(s.ping, s.pingStatus)}</span>
            <span class="signal" data-tone="${tone}"><i></i><i></i><i></i></span>
          </span>
          <span class="loc-actions">
            <button class="icon-btn" data-act="measure" data-id="${s.id}" title="Measure direct TCP latency" aria-label="Measure latency for ${escapeHtml(s.name)}" ${s.pingStatus === 'measuring' ? 'disabled' : ''}>${icon('gauge', 14)}</button>
            <button class="icon-btn" data-act="qr-server" data-id="${s.id}" title="Show QR Code" aria-label="Show QR code for ${escapeHtml(s.name)}">${icon('qr', 14)}</button>
            <button class="icon-btn" data-act="edit-server" data-id="${s.id}" title="Edit" aria-label="Edit ${escapeHtml(s.name)}">${icon('pencil', 14)}</button>
            <button class="icon-btn icon-btn-danger" data-act="delete-server" data-id="${s.id}" title="Delete" aria-label="Delete ${escapeHtml(s.name)}">${icon('trash', 14)}</button>
          </span>
        </div>`;
      })
      .join('');
  }

  function renderDetails(store, node, conn) {
    const st = store.status;
    const exit = st.exitGeo;
    let exitText = '<span class="muted">—</span>';
    if (conn === 'connected') {
      if (exit?.ip) exitText = `<span class="mono">${escapeHtml(exit.ip)}</span>`;
      else exitText = Date.now() - (st.connectedAt || 0) < EXIT_IP_GRACE_MS ? '<span class="muted">Checking…</span>' : '<span class="muted">Unavailable</span>';
    }
    const tunnel = store.tunnelTest;
    const tunnelText =
      conn !== 'connected'
        ? '<span class="muted">—</span>'
        : tunnel?.pending
          ? '<span class="muted">Testing…</span>'
          : tunnel
            ? tunnel.ok
              ? `<span class="tone-good num">OK · ${tunnel.latencyMs} ms</span>`
              : `<span class="tone-bad" title="${escapeHtml(tunnel.error || '')}">Failed</span>`
            : '';
    const latestSpeed = store.data.speedTests?.[0];
    const speedSummary = latestSpeed?.downloadMbps
      ? `<span class="num">↓ ${latestSpeed.downloadMbps} · ↑ ${latestSpeed.uploadMbps ?? '—'} Mbps</span>`
      : '';
    const ab = store.data.adblock;
    const abEnabled = ab?.config?.enabled ?? true;
    const abHasFilters = ['blockYoutubeAds', 'blockAds', 'blockTrackers', 'blockMalware', 'adguardDns'].some((key) => ab?.config?.[key]) || ab?.config?.customBlockedDomains?.length > 0;
    const abSummary = abEnabled && abHasFilters && conn === 'connected'
      ? `<span class="tone-good num">ON · ${(ab?.totalBlocked || 0).toLocaleString()} blocked (${formatBytes(ab?.savedBytes || 0)})</span>`
      : `<span class="muted">${abEnabled ? (conn === 'connected' ? 'Inactive · Enable filters' : 'Ready · Connect VPN') : 'Paused'}</span>`;
    const rows = node
      ? [
          ['pin', 'Location', node.geo ? `${flagHtml(node.geo.countryCode, 18)}<span>${escapeHtml(locationLabel(node.geo))}</span>` : '<span class="muted">Locating…</span>'],
          ['server', 'Server', `<span class="mono" title="${escapeHtml(node.address)}:${node.port}">${escapeHtml(node.address)}:${node.port}</span>`],
          ['layers', 'Protocol', `<span>${protocolText(node)}</span>`],
          ['route', 'Routing', `<span>${st.routingMode === 'tun' ? 'Full TUN' : 'System proxy'}</span>`],
          ['network', 'Exit IP', exitText],
          [
            'gauge',
            'TCP latency',
            (node.ping === null || node.ping === undefined) && node.pingStatus !== 'measuring'
              ? `<button class="link-btn" data-act="measure" data-id="${node.id}">Measure</button>`
              : `<span class="num tone-${latencyTone(node.ping)}" title="${escapeHtml(latencyTitle(node))}">${latencyText(node.ping, node.pingStatus)}</span><button class="link-btn" data-act="measure" data-id="${node.id}" title="Measure again" ${node.pingStatus === 'measuring' ? 'disabled' : ''}>${icon('refresh', 13)}</button>`,
          ],
          ['shieldCheck', 'Ad Shield', `${abSummary}<button class="link-btn" data-act="open-shield">Shield</button>`],
          ['shieldCheck', 'Tunnel check', `${tunnelText}${conn === 'connected' && !tunnel?.pending ? `<button class="link-btn" data-act="tunnel-test">${tunnel ? icon('refresh', 13) : 'Run'}</button>` : ''}`],
          ['zap', 'Speed test', `${speedSummary}<button class="link-btn" data-act="open-speed">${latestSpeed ? 'Details' : 'Run test'}</button>`],
        ]
      : [];
    const html = rows.length
      ? rows.map(([ic, label, value]) => `<div class="detail-row"><span class="detail-label">${icon(ic, 15)}${label}</span><span class="detail-value">${value}</span></div>`).join('')
      : `<div class="empty"><strong>No server selected</strong><p>Choose a location to see its details.</p></div>`;
    if (html !== sigs.details) {
      sigs.details = html;
      ref.details.innerHTML = html;
    }
  }

  function renderRoute(store, node) {
    const origin = store.data.originGeo;
    const parts = [];
    parts.push(
      `<div class="route-point"><span class="route-mark"></span><div><div class="label">You</div><div class="value">${origin ? escapeHtml(locationLabel(origin)) : 'Locating…'}</div></div></div>`
    );
    parts.push('<span class="route-line"></span>');
    parts.push(
      `<div class="route-point"><span class="route-mark is-dest"></span><div><div class="label">VPN server</div><div class="value">${node ? escapeHtml(node.geo ? locationLabel(node.geo) : node.name) : 'None selected'}</div></div></div>`
    );
    if (origin && node?.geo) {
      parts.push(`<span class="route-distance num">${Math.round(haversineKm(origin, node.geo)).toLocaleString()} km</span>`);
    }
    const html = parts.join('');
    if (html !== sigs.route) {
      sigs.route = html;
      ref.route.innerHTML = html;
    }
  }

  function destCard(node, conn) {
    if (!node?.geo) return '';
    const label = conn === 'disconnected' ? 'Selected' : STATE_LABEL[conn];
    const ping = node.ping !== null && node.ping !== undefined && node.ping >= 0 ? ` · ${node.ping} ms` : '';
    return `<div class="mapcard">${flagHtml(node.geo.countryCode, 32)}<div>
      <div class="mapcard-title">${escapeHtml(node.geo.country)}</div>
      <div class="mapcard-sub">${escapeHtml(node.geo.city || node.name)}</div>
      <div class="mapcard-state" data-conn="${conn}"><span class="status-dot"></span>${label}${conn === 'connected' || conn === 'disconnected' ? ping : ''}</div>
    </div></div>`;
  }

  function markerTip(node) {
    return `<div class="maptip">${flagHtml(node.geo.countryCode, 20)}<strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(locationLabel(node.geo))}${node.ping >= 0 && node.ping !== null && node.ping !== undefined ? ` · ${node.ping} ms` : ''}</span></div>`;
  }

  function update(store) {
    lastStore = store;
    const st = store.status;
    if (!st) return;
    const conn = connState(st);
    const node = store.data.servers.find((s) => s.id === st.activeServerId) || null;
    dash.dataset.conn = conn;

    ref.stateText.textContent = STATE_LABEL[conn];
    ref.stateSub.textContent = conn === 'connected' && node?.geo ? `· ${node.geo.country}` : '';
    const powerLabel = conn === 'connected' ? 'Disconnect' : conn === 'connecting' || conn === 'reconnecting' ? 'Cancel' : conn === 'error' ? 'Retry' : 'Connect';
    ref.powerLabel.textContent = powerLabel;
    ref.power.setAttribute('aria-label', powerLabel);
    ref.power.disabled = !node && conn === 'disconnected';

    ref.error.hidden = conn !== 'error';
    if (conn === 'error') ref.errorText.textContent = st.lastError;

    const mapSub = {
      connected: node?.geo ? `Tunnel active via ${node.geo.city || node.geo.country}` : 'Tunnel active',
      connecting: 'Establishing secure tunnel…',
      reconnecting: 'Switching server…',
      error: 'Connection failed — no traffic is flowing',
      disconnected: node ? 'Preview of the selected server' : 'Select a server to preview the route',
    }[conn];
    ref.mapSub.textContent = mapSub;

    renderLocations(store);
    renderDetails(store, node, conn);
    renderRoute(store, node);
    tick(store);

    const origin = store.data.originGeo;
    map.setState({
      origin: origin
        ? { lat: origin.lat, lon: origin.lon, countryCode: origin.countryCode, tip: `<div class="maptip">${icon('home', 15)}<strong>Your location</strong><span>${escapeHtml(locationLabel(origin))}</span></div>` }
        : null,
      markers: store.data.servers
        .filter((s) => s.geo)
        .map((s) => ({ id: s.id, lat: s.geo.lat, lon: s.geo.lon, countryCode: s.geo.countryCode, tip: markerTip(s) })),
      selectedId: node?.geo ? node.id : null,
      conn,
      up: conn === 'connected' ? st.stats.upSpeed : 0,
      down: conn === 'connected' ? st.stats.downSpeed : 0,
      destCard: destCard(node, conn),
    });
  }

  /** Cheap per-second refresh: timer, speed values and sparklines. */
  function tick(store) {
    const st = store.status;
    if (!st) return;
    const conn = connState(st);
    const live = conn === 'connected' || conn === 'reconnecting';
    ref.timer.textContent = live && st.connectedAt ? formatDuration(Date.now() - st.connectedAt) : '00:00:00';
    ref.timerCaption.textContent = live ? 'Session duration' : conn === 'connecting' ? 'Starting Xray core…' : 'Not connected';

    const down = splitBytes(conn === 'connected' ? st.stats.downSpeed : 0);
    const up = splitBytes(conn === 'connected' ? st.stats.upSpeed : 0);
    ref.downVal.innerHTML = `${down.value}<small>${down.unit}/s</small>`;
    ref.upVal.innerHTML = `${up.value}<small>${up.unit}/s</small>`;
    ref.downFoot.innerHTML = `<span>Session ${formatBytes(st.stats.sessionDown)}</span><span>Total ${formatBytes(st.stats.totalDown)}</span>`;
    ref.upFoot.innerHTML = `<span>Session ${formatBytes(st.stats.sessionUp)}</span><span>Total ${formatBytes(st.stats.totalUp)}</span>`;
    drawSparkline(ref.downSpark, store.history.down, '#00A896');
    drawSparkline(ref.upSpark, store.history.up, '#5B7385');
  }

  return { update, tick };
}
