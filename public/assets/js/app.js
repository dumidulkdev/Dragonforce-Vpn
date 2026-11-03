import { brandMark, icon } from './icons.js';
import { connState, createDashboard } from './dashboard.js';
import { APP_RELEASE_INFO, openSubscriptionModal, renderLogLines, renderLogsShell, renderServers, renderSettings, renderSpeed, renderSubscriptions } from './views.js';
import { renderUsage } from './analytics.js';
import { renderShield } from './adblock.js';
import { renderSplitTunnel } from './split-tunnel.js';
import { copyText, escapeHtml, formatBytes, toast } from './ui.js';
import { openServerEditor } from './editor.js';
import { openQrModal } from './qr-modal.js';
import { openOnboardingModal } from './onboarding.js';

const HISTORY_LEN = 60;
const NAV = [
  { id: 'dashboard', label: 'Connect', icon: 'shield' },
  { id: 'shield', label: 'Shield', title: 'Brave-Style Ad & Tracker Blocker', icon: 'shieldCheck' },
  { id: 'split', label: 'Split', title: 'Smart Split Tunneling', icon: 'route' },
  { id: 'usage', label: 'Usage', title: 'Traffic Analytics & Quota', icon: 'chart' },
  { id: 'speed', label: 'Speed', title: 'Speed test', icon: 'gauge' },
  { id: 'servers', label: 'Servers', icon: 'server' },
  { id: 'subscriptions', label: 'Subs', title: 'Subscriptions', icon: 'rss' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const store = {
  status: null,
  data: { servers: [], subscriptions: [] },
  logs: [],
  terminalCommands: {},
  view: NAV.some((n) => `#${n.id}` === location.hash) ? location.hash.slice(1) : 'dashboard',
  logFilter: 'all',
  history: { up: [], down: [] },
  historySession: null,
  tunnelTest: null,
  speedTest: null,
  usagePeriod: '1d',
  usageMode: 'combined',
  usageHoverIdx: null,
  serverFilter: 'all',
  serverSort: 'default',
  serverSearch: '',
  adblockWorkspace: 'overview',
  adblockTab: 'top',
  adblockSearch: '',
  adblockJustToggled: false,
  adblockCheckInput: 'ads.youtube.com',
  adblockCheckResult: null,
  splitTestInput: 'combank.lk',
  splitTestResult: null,
  splitAppSearch: '',
  installedApps: [],
  dynamicColors: null,
  platform: typeof window !== 'undefined' && window.DragonForceAndroid ? 'android' : 'desktop',
};

// ---------------------------------------------------------------- API

let apiToken = '';
async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DragonForce-Token': apiToken },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (result.apiToken) apiToken = result.apiToken;
  return result;
}

async function withBusy(btn, fn) {
  btn?.classList.add('is-busy');
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn?.classList.remove('is-busy');
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- Actions

const actions = {
  navigate(view) {
    store.view = view;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    renderNav();
    renderView();
  },
  async connect() {
    const res = await api('/api/connect', {});
    if (!res.ok && res.error) toast(res.error, 'error');
  },
  async togglePower() {
    const conn = connState(store.status);
    if (conn === 'connected' || conn === 'connecting' || conn === 'reconnecting') {
      await api('/api/disconnect', {});
    } else {
      await actions.connect();
    }
  },
  async selectServer(id) {
    if (id === store.status?.activeServerId) return;
    const node = store.data.servers.find((s) => s.id === id);
    if (store.status?.connected && node) toast(`Switching to ${node.name}…`);
    const res = await api('/api/select-server', { serverId: id });
    if (res && res.ok === false && res.error) toast(res.error, 'error');
  },
  async pingAll(btn) {
    try {
      const res = await withBusy(btn, () => api('/api/ping-all', {}));
      if (res.error) toast(res.error, 'error');
      return res;
    } catch {
      toast('Could not reach the app to measure latency. Try again.', 'error');
    }
  },
  async pingServer(id, btn) {
    try {
      const res = await withBusy(btn, () => api('/api/ping-server', { serverId: id }));
      if (res.error) toast(res.error, 'error');
      return res;
    } catch {
      toast('Could not reach the app to measure latency. Try again.', 'error');
    }
  },
  async testTunnel() {
    store.tunnelTest = { pending: true };
    dashboard.update(store);
    store.tunnelTest = await api('/api/test-tunnel', {});
    dashboard.update(store);
  },
  editServer(id, onAfterSave) {
    const node = store.data.servers.find((s) => s.id === id);
    if (!node) return;
    openServerEditor(
      node,
      async (patch) => {
        const res = await api('/api/update-server', { serverId: id, patch });
        if (res.ok) {
          if (res.node) {
            const idx = store.data.servers.findIndex((s) => s.id === id);
            if (idx >= 0) store.data.servers[idx] = res.node;
          }
          toast(res.reconnected ? 'Saved — reconnected with the new settings' : 'Server updated', 'success');
          if (onAfterSave) setTimeout(() => onAfterSave(), 40);
        }
        return res;
      },
      () => actions.showQr(id)
    );
  },
  showQr(id) {
    openQrModal({
      initialTab: 'share',
      serverId: id,
      store,
      api,
      onEditServer: (sid, cb) => actions.editServer(sid, cb),
    });
  },
  scanQr() {
    openQrModal({
      initialTab: 'scan',
      store,
      api,
      onEditServer: (sid, cb) => actions.editServer(sid, cb),
    });
  },
  /** Two-step delete: the first click arms the button, the second confirms. */
  async deleteServer(id, btn) {
    if (confirmTwice(btn, `s:${id}`)) await api('/api/delete-server', { serverId: id });
  },
};

// ---------------------------------------------------------------- Shell

const rail = document.getElementById('rail');
const views = Object.fromEntries(NAV.map((n) => [n.id, document.getElementById(`view-${n.id}`)]));
const dashboard = createDashboard(views.dashboard, actions);

function getActiveTheme() {
  return store.data?.theme || document.documentElement.dataset.theme || localStorage.getItem('vpn_theme') || 'light';
}

async function applyTheme(theme, { persist = true, notify = false } = {}) {
  const normalized =
    theme === 'material_you' ? 'material_you' : theme === 'dark' ? 'dark' : 'light';
  const baseMode = normalized === 'light' ? 'light' : 'dark';
  const prev = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = baseMode;
  document.documentElement.dataset.themeMode = normalized;

  if (normalized === 'material_you') {
    document.documentElement.dataset.materialYou = 'true';
    const dyn = store.dynamicColors;
    const accent = dyn?.accentHex || '#E11D48';
    const accentSoft = dyn?.accentSoftHex || 'rgba(225, 29, 72, 0.16)';
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-strong', accent);
    document.documentElement.style.setProperty('--accent-soft', accentSoft);
  } else {
    delete document.documentElement.dataset.materialYou;
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-strong');
    document.documentElement.style.removeProperty('--accent-soft');
  }

  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  if (metaScheme) metaScheme.setAttribute('content', baseMode);
  try {
    localStorage.setItem('vpn_theme', normalized);
  } catch {
    /* ignore */
  }
  if (store.data) store.data.theme = normalized;
  if (prev !== baseMode) {
    window.dispatchEvent(new CustomEvent('vpn-theme-change', { detail: { theme: baseMode, mode: normalized } }));
  }
  renderNav();
  if (store.status) renderView(false);
  if (notify) {
    toast(
      normalized === 'material_you'
        ? 'Material You dynamic theme enabled'
        : normalized === 'dark'
          ? 'Dark theme enabled'
          : 'Light theme enabled'
    );
  }
  if (persist) {
    await api('/api/settings', { theme: normalized }).catch(() => {});
  }
}

// Apply saved theme immediately before first paint
try {
  const cachedTheme = localStorage.getItem('vpn_theme');
  if (cachedTheme === 'dark' || cachedTheme === 'light' || cachedTheme === 'material_you') {
    const baseMode = cachedTheme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = baseMode;
    document.documentElement.dataset.themeMode = cachedTheme;
    const metaScheme = document.querySelector('meta[name="color-scheme"]');
    if (metaScheme) metaScheme.setAttribute('content', baseMode);
  }
} catch {
  /* ignore */
}

function renderNav() {
  const admin = store.status?.isAdmin;
  const isDark = getActiveTheme() === 'dark';
  rail.innerHTML = `
    <div class="rail-brand" data-rail-about="open" title="${APP_RELEASE_INFO.name} ${APP_RELEASE_INFO.version} — Click for About & Release Info" style="cursor:pointer">${brandMark(36)}</div>
    <div class="rail-nav">
      ${NAV.map((n) => `<button class="rail-item${store.view === n.id ? ' is-active' : ''}" data-nav="${n.id}" aria-current="${store.view === n.id ? 'page' : 'false'}" title="${n.title || n.label}">${icon(n.icon, 20)}<span>${n.label}</span></button>`).join('')}
    </div>
    <div class="rail-foot">
      <button type="button" class="rail-theme-btn" data-rail-theme="toggle" title="${isDark ? 'Switch to Light theme' : 'Switch to Dark theme'}" aria-label="Toggle dark theme">
        ${icon(isDark ? 'sun' : 'moon', 17)}
      </button>
      <span class="rail-badge${admin ? ' is-admin' : ''}" title="${admin ? 'Administrator — Full TUN available' : 'Standard user — System proxy only'}">${icon(admin ? 'shieldCheck' : 'shield', 18)}</span>
      <span class="rail-badge-label">${admin ? 'Admin' : 'Standard'}</span>
      <button type="button" class="rail-ver-pill" data-rail-about="open" title="About ${APP_RELEASE_INFO.name} (${APP_RELEASE_INFO.version})">${APP_RELEASE_INFO.version}</button>
    </div>`;
}

rail.addEventListener('click', (e) => {
  const aboutBtn = e.target.closest('[data-rail-about]');
  if (aboutBtn) {
    actions.navigate('settings');
    setTimeout(() => {
      document.getElementById('about-dragonforce')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return;
  }
  const themeBtn = e.target.closest('[data-rail-theme]');
  if (themeBtn) {
    const next = getActiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, { persist: true, notify: true });
    return;
  }
  const btn = e.target.closest('[data-nav]');
  if (btn) actions.navigate(btn.dataset.nav);
});

/** Pages re-render on data changes, but never while the user is typing in them. */
function renderView(force = true) {
  for (const [id, el] of Object.entries(views)) el.hidden = id !== store.view;
  const el = views[store.view];
  if (store.view === 'dashboard') return dashboard.update(store);
  if (!force && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  if (store.view === 'shield') renderShield(el, store);
  if (store.view === 'split') renderSplitTunnel(el, store);
  if (store.view === 'usage') renderUsage(el, store);
  if (store.view === 'speed') renderSpeed(el, store);
  if (store.view === 'servers') renderServers(el, store);
  if (store.view === 'subscriptions') renderSubscriptions(el, store);
  if (store.view === 'settings') renderSettings(el, store);
  if (store.view === 'logs') renderLogsShell(el, store);
}

// ---------------------------------------------------------------- Page events

function pageInput(name) {
  return views[store.view].querySelector(`[data-ref="${name}"]`);
}

async function importLinks(rawText) {
  const text = (rawText ?? pageInput('linkInput')?.value ?? '').trim();
  if (!text) return;
  const res = await api('/api/import-links', { rawText: text });
  if (res.importedCount > 0) {
    toast(`Imported ${res.importedCount} server${res.importedCount === 1 ? '' : 's'}`, 'success');
    if (pageInput('linkInput')) pageInput('linkInput').value = '';
  } else {
    toast(res.errors?.[0] || 'No valid vless:// or vmess:// links found', 'error');
  }
}

const pendingDelete = new Map();
function confirmTwice(btn, key) {
  if (pendingDelete.get(key)) {
    pendingDelete.delete(key);
    return true;
  }
  pendingDelete.set(key, true);
  btn.classList.add('is-armed');
  btn.title = 'Click again to delete';
  btn.setAttribute('aria-label', 'Click again to delete');
  setTimeout(() => {
    if (pendingDelete.delete(key)) {
      btn.classList.remove('is-armed');
      btn.title = 'Delete';
    }
  }, 3000);
  return false;
}

function openConfigModal(name, json) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal" data-act="close-modal"><div class="panel modal-box" role="dialog" aria-modal="true" aria-label="Generated Xray config">
    <div class="modal-head"><h3>Xray config · ${escapeHtml(name)}</h3><div class="row"><button class="btn btn-sm" data-act="copy-config">${icon('copy', 15)}Copy</button><button class="btn btn-ghost btn-icon btn-sm" data-act="close-modal" aria-label="Close">${icon('x', 16)}</button></div></div>
    <pre class="modal-body">${escapeHtml(json)}</pre></div></div>`;
  root.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'copy-config') copyText(json, 'Config copied');
    else if (act === 'close-modal' && (e.target === e.currentTarget.firstElementChild || e.target.closest('button'))) root.innerHTML = '';
  };
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('modal-root').innerHTML = '';
});

async function onPageClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) {
    const card = e.target.closest('.srv-node-card[data-id]');
    if (card && !e.target.closest('button')) {
      return actions.selectServer(card.dataset.id);
    }
    return;
  }
  const id = btn.dataset.id;
  switch (btn.dataset.act) {
    case 'import':
      return importLinks();
    case 'paste':
      try {
        return importLinks(await navigator.clipboard.readText());
      } catch {
        return toast('Clipboard unavailable — paste with Ctrl+V', 'error');
      }
    case 'srv-filter':
      store.serverFilter = btn.dataset.proto || 'all';
      return renderView();
    case 'srv-sort':
      store.serverSort = store.serverSort === 'ping' ? 'default' : 'ping';
      return renderView();
    case 'quick-connect': {
      const conn = connState(store.status);
      if (id === store.status?.activeServerId && conn === 'connected') {
        return api('/api/disconnect', {});
      }
      if (id !== store.status?.activeServerId) {
        await actions.selectServer(id);
      }
      if (!store.status?.connected) {
        await actions.connect();
      }
      return;
    }
    case 'ping':
      return actions.pingServer(id, btn);
    case 'ping-all':
      return actions.pingAll(btn);
    case 'config': {
      const node = store.data.servers.find((s) => s.id === id);
      const res = await api('/api/server-config', { serverId: id });
      return openConfigModal(node?.name || 'server', res.json);
    }
    case 'copy-link': {
      const node = store.data.servers.find((s) => s.id === id);
      return node && copyText(node.rawUri, 'Share link copied');
    }
    case 'delete-server':
      return actions.deleteServer(id, btn);
    case 'edit-server':
      return actions.editServer(id);
    case 'qr-server':
      return actions.showQr(id);
    case 'scan-qr':
      return actions.scanQr();
    case 'add-sub': {
      const url = pageInput('subUrl').value.trim();
      if (!url) return toast('Enter a subscription URL', 'error');
      return withBusy(btn, async () => {
        const res = await api('/api/add-subscription', { url, name: pageInput('subName').value.trim() });
        toast(res.ok ? `Added ${res.count} servers` : res.error || 'Could not fetch subscription', res.ok ? 'success' : 'error');
      });
    }
    case 'paste-sub-url': {
      try {
        const clip = (await navigator.clipboard.readText()).trim();
        const input = pageInput('subUrl');
        if (input && clip) {
          input.value = clip;
          input.focus();
          toast('Subscription URL pasted');
        }
      } catch {
        toast('Clipboard unavailable — paste with Ctrl+V', 'error');
      }
      return;
    }
    case 'copy-sub-url':
      return copyText(btn.dataset.url, 'Subscription URL copied');
    case 'view-sub':
      return openSubscriptionModal({ subId: id, store, api, actions });
    case 'ping-sub':
      return withBusy(btn, async () => {
        const res = await api('/api/ping-subscription', { subId: id });
        if (res.ok) toast(`Measured latency for ${res.count} subscription node${res.count === 1 ? '' : 's'}`, 'success');
      });
    case 'sync-all-subs':
      return withBusy(btn, async () => {
        const res = await api('/api/sync-all-subscriptions', {});
        toast(
          res.ok ? `Synced ${res.syncedSubs} subscription${res.syncedSubs === 1 ? '' : 's'} (${res.totalNodes} nodes)` : 'Sync failed',
          res.ok ? 'success' : 'error'
        );
      });
    case 'sync-sub':
      return withBusy(btn, async () => {
        const res = await api('/api/refresh-subscription', { subId: id });
        toast(res.ok ? `Synced · ${res.count} servers` : res.error || 'Sync failed', res.ok ? 'success' : 'error');
      });
    case 'delete-sub':
      if (confirmTwice(btn, `sub:${id}`)) await api('/api/delete-subscription', { subId: id });
      return;
    case 'mode': {
      const res = await api('/api/routing-mode', { mode: btn.dataset.mode });
      if (res && res.ok === false && res.error) toast(res.error, 'error');
      return;
    }
    case 'terminal-env':
      return api('/api/terminal-env', { enabled: !store.status.terminalEnvActive });
    case 'mux-enabled':
      return api('/api/settings', { muxEnabled: !store.data.muxEnabled });
    case 'bypass-lan':
      return api('/api/settings', { bypassLan: !store.data.bypassLan });
    case 'allow-insecure':
      return api('/api/settings', { allowInsecureDefault: !store.data.allowInsecureDefault });
    case 'toggle-theme': {
      const next = getActiveTheme() === 'light' ? 'dark' : 'light';
      return applyTheme(next, { persist: true, notify: true });
    }
    case 'set-theme': {
      const target =
        btn.dataset.theme === 'material_you'
          ? 'material_you'
          : btn.dataset.theme === 'dark'
            ? 'dark'
            : 'light';
      return applyTheme(target, { persist: true, notify: true });
    }
    case 'notif-toggle': {
      const key = btn.dataset.key;
      if (!key) return;
      const cur = store.data.notifications?.[key] !== false;
      const nextNotifs = { ...(store.data.notifications || {}), [key]: !cur };
      store.data.notifications = nextNotifs;
      await api('/api/settings', { notifications: nextNotifs }).catch(() => {});
      return renderView();
    }
    case 'speed-start': {
      const res = await api('/api/speedtest/start', {});
      if (res && res.ok === false && res.error) toast(res.error, 'error');
      return;
    }
    case 'speed-cancel':
      return api('/api/speedtest/cancel', {});
    case 'copy-ip':
      return copyText(btn.dataset.ip, 'IP address copied');
    case 'usage-period':
      store.usagePeriod = btn.dataset.period;
      store.usageHoverIdx = null;
      return renderView();
    case 'usage-mode':
      store.usageMode = btn.dataset.mode;
      return renderView();
    case 'usage-reset':
      if (confirmTwice(btn, 'usage-reset')) {
        await api('/api/usage/reset', {});
        toast('Usage history reset', 'success');
      }
      return;
    case 'cap-toggle': {
      const cap = store.data.usageHistory?.dataCap;
      return api('/api/usage/datacap', { enabled: !cap?.enabled });
    }
    case 'cap-period':
      return api('/api/usage/datacap', { period: btn.dataset.period });
    case 'cap-limit': {
      const gb = Number(btn.dataset.gb);
      if (gb > 0) {
        await api('/api/usage/datacap', { enabled: true, limitBytes: gb * 1024 * 1024 * 1024 });
        toast(`Data cap set to ${gb} GB`, 'success');
      }
      return;
    }
    case 'cap-autodisconnect': {
      const cap = store.data.usageHistory?.dataCap;
      return api('/api/usage/datacap', { autoDisconnect: !cap?.autoDisconnect });
    }
    case 'save-ports': {
      const socksPort = Number(pageInput('socksPort').value);
      const httpPort = Number(pageInput('httpPort').value);
      const valid = (p) => Number.isInteger(p) && p > 1024 && p < 65536;
      if (!valid(socksPort) || !valid(httpPort) || socksPort === httpPort) return toast('Use two different ports between 1025 and 65535', 'error');
      const res = await api('/api/settings', { socksPort, httpPort });
      if (!res.ok) {
        toast(res.error || 'Could not save ports', 'error');
        return renderView();
      }
      store.terminalCommands = res.terminalCommands || store.terminalCommands;
      toast('Ports saved', 'success');
      return renderView();
    }
    case 'copy-cmd':
      return copyText(btn.dataset.cmd, 'Command copied');
    case 'elevate':
      return elevate();
    case 'open-onboarding':
      return openOnboardingModal({
        store,
        api,
        onComplete: () => renderView(),
        onOpenQrScanner: () => actions.scanQr(),
      });
    case 'log-filter':
      store.logFilter = btn.dataset.filter;
      return renderView();
    case 'clear-logs':
      await api('/api/clear-logs', {});
      store.logs = [];
      return renderView();
    case 'ab-workspace':
      store.adblockWorkspace = btn.dataset.ws || 'overview';
      return renderView();
    case 'ab-toggle': {
      const cfg = store.data.adblock?.config || { enabled: true };
      const next = !cfg.enabled;
      if (store.data.adblock?.config) store.data.adblock.config.enabled = next;
      store.adblockJustToggled = true;
      renderView();
      setTimeout(() => {
        store.adblockJustToggled = false;
      }, 950);
      const res = await api('/api/adblock/config', { enabled: next }).catch(() => null);
      if (res?.adblock) store.data.adblock = res.adblock;
      if (!res?.ok) toast(res?.error || 'Could not update Shield', 'error');
      else toast(next ? (store.status?.connected ? 'Privacy & Ad Shield enabled' : 'Shield configured — connect VPN to activate') : 'Privacy & Ad Shield paused', 'info');
      return renderView();
    }
    case 'ab-preset-domain': {
      const dom = btn.dataset.domain;
      if (!dom) return;
      store.adblockCheckInput = dom;
      const inputEl = pageInput('abCheckInput');
      if (inputEl) inputEl.value = dom;
      const res = await api('/api/adblock/check-domain', { domain: dom }).catch(() => null);
      if (res?.ok) {
        store.adblockCheckResult = res;
      }
      return renderView();
    }
    case 'ab-check-domain': {
      const dom = (pageInput('abCheckInput')?.value || store.adblockCheckInput || '').trim();
      if (!dom) return toast('Enter a domain to preview', 'error');
      store.adblockCheckInput = dom;
      const res = await api('/api/adblock/check-domain', { domain: dom }).catch(() => null);
      if (res?.ok) {
        store.adblockCheckResult = res;
        toast(res.blocked ? `Rule preview: ${dom} would be blocked` : `Rule preview: ${dom} is allowed by configured rules`, 'info');
      }
      return renderView();
    }
    case 'ab-layer': {
      const key = btn.dataset.key;
      if (!key) return;
      const cfg = store.data.adblock?.config || {};
      const next = !cfg[key];
      if (store.data.adblock?.config) store.data.adblock.config[key] = next;
      renderView();
      const res = await api('/api/adblock/config', { [key]: next }).catch(() => null);
      if (res?.adblock) store.data.adblock = res.adblock;
      return renderView();
    }
    case 'ab-test':
      return withBusy(btn, async () => {
        const res = await api('/api/adblock/test', {});
        if (res.ok) {
          toast(`Shield verified: blocked ${res.blockedCount} ad & tracker probes`, 'success');
          renderView();
        } else {
          toast(res.error || 'Could not run shield test', 'error');
        }
      });
    case 'ab-reset':
      if (confirmTwice(btn, 'ab-reset')) {
        const res = await api('/api/adblock/reset', {});
        if (res?.adblock) store.data.adblock = res.adblock;
        toast('Ad Shield statistics reset', 'success');
        renderView();
      }
      return;
    case 'ab-tab':
      store.adblockTab = btn.dataset.tab || 'top';
      return renderView();
    case 'ab-add-block': {
      const val = pageInput('abBlockInput')?.value.trim();
      if (!val) return toast('Enter a domain to block', 'error');
      const res = await api('/api/adblock/config', { addBlockedDomain: val });
      if (res?.adblock) store.data.adblock = res.adblock;
      toast(`Blocked ${val}`, 'success');
      return renderView();
    }
    case 'ab-rm-block': {
      const res = await api('/api/adblock/config', { removeBlockedDomain: btn.dataset.domain });
      if (res?.adblock) store.data.adblock = res.adblock;
      return renderView();
    }
    case 'ab-add-white': {
      const val = pageInput('abWhiteInput')?.value.trim();
      if (!val) return toast('Enter a domain to whitelist', 'error');
      const res = await api('/api/adblock/config', { addWhitelistedDomain: val });
      if (res?.adblock) store.data.adblock = res.adblock;
      toast(`Whitelisted ${val}`, 'success');
      return renderView();
    }
    case 'ab-rm-white': {
      const res = await api('/api/adblock/config', { removeWhitelistedDomain: btn.dataset.domain });
      if (res?.adblock) store.data.adblock = res.adblock;
      return renderView();
    }
    case 'ab-quick-whitelist': {
      const domain = btn.dataset.domain;
      if (!domain) return;
      const res = await api('/api/adblock/config', { addWhitelistedDomain: domain });
      if (res?.adblock) store.data.adblock = res.adblock;
      toast(`Whitelisted ${domain}`, 'success');
      return renderView();
    }
    case 'open-split':
      return actions.navigate('split');
    case 'st-mode': {
      const mode = btn.dataset.mode;
      if (!mode) return;
      if (!store.data.splitTunnel) store.data.splitTunnel = { mode, presets: {}, customDomains: [], customIps: [] };
      store.data.splitTunnel.mode = mode;
      store.splitTestResult = null;
      renderView();
      const res = await api('/api/split-tunnel/config', { mode }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      toast(
        mode === 'bypass'
          ? 'Split Tunneling: Selected apps & sites now bypass VPN'
          : mode === 'vpn_only'
          ? 'Split Tunneling: Only selected apps & sites use VPN'
          : 'Split Tunneling off — all traffic encrypted via VPN',
        'success'
      );
      return renderView();
    }
    case 'st-preset': {
      const presetId = btn.dataset.preset;
      if (!presetId) return;
      store.splitTestResult = null;
      const res = await api('/api/split-tunnel/config', { presetId }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      return renderView();
    }
    case 'st-add-target': {
      const val = pageInput('stTargetInput')?.value.trim();
      if (!val) return toast('Enter a domain (e.g. netflix.com, *.lk) or IP range', 'error');
      const res = await api('/api/split-tunnel/config', { addTarget: val }).catch(() => null);
      if (!res?.ok) return toast(res?.error || 'Invalid domain or IP range', 'error');
      if (res.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      store.splitTestResult = null;
      toast(`Added ${val} to Split Tunnel rules`, 'success');
      return renderView();
    }
    case 'st-quick-add': {
      const val = btn.dataset.target;
      if (!val) return;
      const res = await api('/api/split-tunnel/config', { addTarget: val }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      store.splitTestResult = null;
      toast(`Added ${val} to Split Tunnel rules`, 'success');
      return renderView();
    }
    case 'st-rm-domain': {
      const domain = btn.dataset.domain;
      if (!domain) return;
      const res = await api('/api/split-tunnel/config', { removeDomain: domain }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      store.splitTestResult = null;
      return renderView();
    }
    case 'st-rm-ip': {
      const ip = btn.dataset.ip;
      if (!ip) return;
      const res = await api('/api/split-tunnel/config', { removeIp: ip }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      store.splitTestResult = null;
      return renderView();
    }
    case 'st-sample-route': {
      const target = btn.dataset.target;
      if (!target) return;
      store.splitTestInput = target;
      const res = await api('/api/split-tunnel/test', { target }).catch(() => null);
      if (res?.ok) store.splitTestResult = res;
      return renderView();
    }
    case 'st-test-route': {
      const target = (pageInput('stTestInput')?.value || store.splitTestInput || '').trim();
      if (!target) return toast('Enter a domain or IP to trace', 'error');
      store.splitTestInput = target;
      const res = await api('/api/split-tunnel/test', { target }).catch(() => null);
      if (res?.ok) store.splitTestResult = res;
      return renderView();
    }
    case 'st-per-app-mode': {
      const perAppMode = btn.dataset.mode;
      if (!perAppMode) return;
      const res = await api('/api/split-tunnel/config', { perAppMode }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      toast(
        perAppMode === 'off'
          ? 'Per-App Split Tunneling turned off (All apps use default policy)'
          : perAppMode === 'bypass_selected'
            ? 'Per-App Split Tunneling: Bypassing selected apps directly via ISP'
            : 'Per-App Split Tunneling: Routing only selected apps through VPN',
        'success'
      );
      return renderView();
    }
    case 'st-toggle-app': {
      const pkg = btn.dataset.pkg;
      if (!pkg) return;
      const res = await api('/api/split-tunnel/config', { toggleApp: pkg }).catch(() => null);
      if (res?.splitTunnel) store.data.splitTunnel = res.splitTunnel;
      return renderView();
    }
  }
}

for (const id of ['shield', 'split', 'usage', 'speed', 'servers', 'subscriptions', 'settings', 'logs']) {
  views[id].addEventListener('click', onPageClick);
  views[id].addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.dataset.ref === 'linkInput') importLinks();
    if (e.target.dataset.ref === 'subUrl') views[id].querySelector('[data-act="add-sub"]')?.click();
    if (e.target.dataset.ref === 'abBlockInput') views[id].querySelector('[data-act="ab-add-block"]')?.click();
    if (e.target.dataset.ref === 'abWhiteInput') views[id].querySelector('[data-act="ab-add-white"]')?.click();
    if (e.target.dataset.ref === 'abCheckInput') views[id].querySelector('[data-act="ab-check-domain"]')?.click();
    if (e.target.dataset.ref === 'stTargetInput') views[id].querySelector('[data-act="st-add-target"]')?.click();
    if (e.target.dataset.ref === 'stTestInput') views[id].querySelector('[data-act="st-test-route"]')?.click();
  });
}

views.shield.addEventListener('input', (e) => {
  if (e.target.dataset.ref === 'abSearch') {
    const pos = e.target.selectionStart ?? e.target.value.length;
    store.adblockSearch = e.target.value;
    renderShield(views.shield, store);
    const nextInput = views.shield.querySelector('[data-ref="abSearch"]');
    if (nextInput) {
      nextInput.focus();
      try {
        nextInput.setSelectionRange(pos, pos);
      } catch {
        /* ignore */
      }
    }
  }
});

views.servers.addEventListener('input', (e) => {
  if (e.target.dataset.ref === 'srvSearch') {
    const pos = e.target.selectionStart ?? e.target.value.length;
    store.serverSearch = e.target.value;
    renderServers(views.servers, store);
    const nextInput = views.servers.querySelector('[data-ref="srvSearch"]');
    if (nextInput) {
      nextInput.focus();
      try {
        nextInput.setSelectionRange(pos, pos);
      } catch {
        /* ignore */
      }
    }
  }
});

views.split.addEventListener('input', (e) => {
  if (e.target.dataset.ref === 'stAppSearch') {
    const pos = e.target.selectionStart ?? e.target.value.length;
    store.splitAppSearch = e.target.value;
    renderSplitTunnel(views.split, store);
    const nextInput = views.split.querySelector('[data-ref="stAppSearch"]');
    if (nextInput) {
      nextInput.focus();
      try {
        nextInput.setSelectionRange(pos, pos);
      } catch {
        /* ignore */
      }
    }
  }
});

async function elevate() {
  toast('Approve the Windows prompt to restart as administrator…');
  const result = await api('/api/relaunch-admin', {}).catch(() => null);
  if (result?.ok === false) return toast(result.error || 'Could not restart as administrator', 'error');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch('/api/init', { signal: AbortSignal.timeout(3000) });
      if (res.ok && (await res.json()).status?.isAdmin) return window.location.reload();
    } catch {
      /* waiting for the elevated instance */
    }
  }
  toast('The administrator controller did not become ready. Try Elevate again.', 'error');
}

// ---------------------------------------------------------------- Live data

function sampleHistory() {
  const st = store.status;
  if (!st) return;
  const conn = connState(st);
  if (conn === 'connected') {
    if (store.historySession !== st.connectedAt) {
      store.historySession = st.connectedAt;
      store.history = { up: [], down: [] };
      store.tunnelTest = null;
    }
    store.history.up = [...store.history.up, st.stats.upSpeed].slice(-HISTORY_LEN);
    store.history.down = [...store.history.down, st.stats.downSpeed].slice(-HISTORY_LEN);
  }
  if (store.view === 'dashboard' && !document.hidden) dashboard.tick(store);
}

let logFrame = 0;
function scheduleLogRender() {
  if (store.view !== 'logs' || logFrame) return;
  logFrame = requestAnimationFrame(() => {
    logFrame = 0;
    renderLogLines(views.logs, store);
  });
}

async function init() {
  try {
    window.moveTo(0, 0);
    window.resizeTo(window.screen.availWidth, window.screen.availHeight);
  } catch {
    /* browser tab mode */
  }
  renderNav();
  const initial = await api('/api/init');
  Object.assign(store, {
    status: initial.status,
    data: initial.data,
    logs: initial.logs,
    terminalCommands: initial.terminalCommands,
    installedApps: initial.installedApps || [],
    dynamicColors: initial.dynamicColors || null,
    platform: initial.platform || store.platform,
  });

  window.addEventListener('dragonforce:native', async (e) => {
    const detail = e.detail || {};
    if (detail.type === 'navigateView' && detail.payload) {
      actions.navigate(detail.payload);
    } else if (detail.type === 'quickConnect') {
      await actions.connect();
    } else if (detail.type === 'importUri' && detail.payload) {
      const text = String(detail.payload).trim();
      if (/^https?:\/\//i.test(text)) {
        actions.navigate('subscriptions');
        const res = await api('/api/add-subscription', { url: text, name: '' });
        toast(res.ok ? `Added ${res.count} servers from shared link` : res.error || 'Import failed', res.ok ? 'success' : 'error');
      } else {
        await importLinks(text);
      }
    } else if (detail.type === 'vpnPermissionDenied') {
      toast(detail.payload || 'VPN permission denied', 'error');
    }
  });
  const initTheme = store.data?.theme || localStorage.getItem('vpn_theme') || 'light';
  await applyTheme(initTheme, { persist: false, notify: false });
  renderNav();
  renderView();

  if (!store.data.onboardingCompleted) {
    openOnboardingModal({
      store,
      api,
      onComplete: () => renderView(),
      onOpenQrScanner: () => actions.scanQr(),
    });
  }

  const events = new EventSource('/api/events');
  events.addEventListener('session', (e) => { apiToken = JSON.parse(e.data).apiToken; });
  events.addEventListener('status', (e) => {
    const prevAdmin = store.status?.isAdmin;
    store.status = JSON.parse(e.data);
    if (prevAdmin !== store.status.isAdmin) renderNav();
    if (store.view === 'dashboard') dashboard.update(store);
    else if (store.view === 'shield' || store.view === 'settings' || store.view === 'speed' || store.view === 'servers' || store.view === 'subscriptions') renderView(false);
  });
  events.addEventListener('data', (e) => {
    store.data = JSON.parse(e.data);
    if (store.data?.theme && store.data.theme !== document.documentElement.dataset.theme) {
      applyTheme(store.data.theme, { persist: false, notify: false });
    }
    renderView(false);
  });
  events.addEventListener('speedtest', (e) => {
    store.speedTest = JSON.parse(e.data);
    if (store.view === 'speed') renderSpeed(views.speed, store);
    else if (store.view === 'dashboard' && store.speedTest.done) dashboard.update(store);
  });
  events.addEventListener('datacap', (e) => {
    const d = JSON.parse(e.data);
    if (d.level === 'limit') {
      toast(`Data cap reached (${formatBytes(d.usedBytes)} / ${formatBytes(d.limitBytes)} ${d.periodLabel})${d.autoDisconnect ? ' — VPN disconnected' : ''}`, 'error');
    } else {
      toast(`Data usage alert: ${d.pct}% of ${d.periodLabel} cap used (${formatBytes(d.usedBytes)} / ${formatBytes(d.limitBytes)})`, 'error');
    }
  });
  events.addEventListener('log', (e) => {
    store.logs.push(JSON.parse(e.data));
    if (store.logs.length > 400) store.logs.shift();
    scheduleLogRender();
  });

  setInterval(sampleHistory, 1000);
}

init();
