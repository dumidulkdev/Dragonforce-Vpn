import { icon } from './icons.js';
import { escapeHtml, flagHtml, formatBytes, formatDuration, splitBytes } from './ui.js';

const PERIODS = [
  { id: '1h', label: '1H', title: 'Last 60 minutes (1-min intervals)' },
  { id: '1d', label: '1D', title: 'Last 24 hours (hourly intervals)' },
  { id: '1w', label: '1W', title: 'Last 7 days (daily intervals)' },
  { id: '1m', label: '1M', title: 'Last 30 days (daily intervals)' },
];

const SERIES_MODES = [
  { id: 'combined', label: 'Combined' },
  { id: 'down', label: 'Download' },
  { id: 'up', label: 'Upload' },
];

const CAP_PRESETS_GB = [5, 10, 25, 50, 100, 250, 500];

function formatDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Builds a complete, chronologically ordered array of time slots for the chosen period,
 * merging persisted buckets from `usageHistory`.
 */
function buildSeries(usageHistory, period, now = Date.now()) {
  const mins = new Map((usageHistory?.minutes || []).map((b) => [Number(b.timestamp), b]));
  const hours = new Map((usageHistory?.hours || []).map((b) => [Number(b.timestamp), b]));
  const days = new Map((usageHistory?.days || []).map((b) => [b.key, b]));

  const slots = [];

  if (period === '1h') {
    const curMin = Math.floor(now / 60_000) * 60_000;
    for (let i = 29; i >= 0; i--) {
      const t0 = curMin - i * 2 * 60_000;
      const t1 = t0 + 60_000;
      const b0 = mins.get(t0);
      const b1 = mins.get(t1);
      const down = (b0?.downBytes || 0) + (b1?.downBytes || 0);
      const up = (b0?.upBytes || 0) + (b1?.upBytes || 0);
      const d = new Date(t1);
      slots.push({
        timestamp: t1,
        label: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        shortLabel: i === 0 ? 'Now' : i % 5 === 0 ? `${i * 2}m ago` : '',
        downBytes: down,
        upBytes: up,
        totalBytes: down + up,
      });
    }
  } else if (period === '1d') {
    const curHour = Math.floor(now / 3600_000) * 3600_000;
    for (let i = 23; i >= 0; i--) {
      const ts = curHour - i * 3600_000;
      const b = hours.get(ts);
      const down = b?.downBytes || 0;
      const up = b?.upBytes || 0;
      const d = new Date(ts);
      slots.push({
        timestamp: ts,
        label: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        shortLabel: i % 3 === 0 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        downBytes: down,
        upBytes: up,
        totalBytes: down + up,
      });
    }
  } else {
    const count = period === '1w' ? 7 : 30;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      const key = formatDayKey(d.getTime());
      const b = days.get(key);
      const down = b?.downBytes || 0;
      const up = b?.upBytes || 0;
      const short =
        period === '1w'
          ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
          : i % 4 === 0 || i === 0
            ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            : '';
      slots.push({
        timestamp: d.getTime(),
        label: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        shortLabel: short,
        downBytes: down,
        upBytes: up,
        totalBytes: down + up,
      });
    }
  }

  return slots;
}

/**
 * Generates a smooth monotone cubic-bezier SVG path from [x, y] points.
 */
function smoothSvgPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    let cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    let cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    const minY = Math.min(p1[1], p2[1]);
    const maxY = Math.max(p1[1], p2[1]);
    cp1y = Math.max(minY, Math.min(maxY, cp1y));
    cp2y = Math.max(minY, Math.min(maxY, cp2y));
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function renderSegmentedMeter(pct, tone = 'amber', segments = 38) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segments);
  let bars = '';
  for (let i = 0; i < segments; i++) {
    bars += `<i class="${i < filled ? `is-on is-${tone}` : ''}"></i>`;
  }
  return `<div class="seg-meter" aria-hidden="true">${bars}</div>`;
}

export function renderUsage(root, store) {
  const period = store.usagePeriod || '1d';
  const mode = store.usageMode || 'combined';
  const h = store.data.usageHistory || {
    minutes: [],
    hours: [],
    days: [],
    perServer: {},
    dataCap: { enabled: false, period: 'monthly', limitBytes: 50 * 1024 ** 3, alertPct: 80, autoDisconnect: false },
    peakDownSpeed: 0,
    peakUpSpeed: 0,
  };

  const slots = buildSeries(h, period);
  const valOf = (s) => (mode === 'down' ? s.downBytes : mode === 'up' ? s.upBytes : s.totalBytes);
  const values = slots.map(valOf);

  const periodDown = slots.reduce((sum, s) => sum + s.downBytes, 0);
  const periodUp = slots.reduce((sum, s) => sum + s.upBytes, 0);
  const periodTotal = periodDown + periodUp;
  const activeSlots = values.filter((v) => v > 0);
  const avgVal = activeSlots.length ? activeSlots.reduce((a, b) => a + b, 0) / activeSlots.length : 0;
  const peakVal = Math.max(0, ...values);

  // Rolling baseline curve (smooth moving average for visual comparison like Screenshot 1)
  const avgSeries = values.map((_, idx) => {
    const win = values.slice(Math.max(0, idx - 2), Math.min(values.length, idx + 3));
    const localAvg = win.reduce((a, b) => a + b, 0) / win.length;
    return Math.max(localAvg * 0.85, avgVal * 0.45);
  });

  // Select active hover index (defaults to the latest non-zero slot, or last slot)
  let activeIdx =
    typeof store.usageHoverIdx === 'number' && store.usageHoverIdx >= 0 && store.usageHoverIdx < slots.length
      ? store.usageHoverIdx
      : -1;
  if (activeIdx === -1) {
    for (let i = slots.length - 1; i >= 0; i--) {
      if (values[i] > 0) {
        activeIdx = i;
        break;
      }
    }
    if (activeIdx === -1) activeIdx = slots.length - 1;
  }

  // Chart geometry
  const W = 920;
  const H = 290;
  const padL = 68;
  const padR = 24;
  const padT = 22;
  const padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxY = Math.max(peakVal * 1.18, 10 * 1024 * 1024); // minimum 10 MB scale
  const xAt = (i) => padL + (slots.length > 1 ? (i / (slots.length - 1)) * plotW : plotW / 2);
  const yAt = (v) => padT + plotH - Math.min(1, Math.max(0, v / maxY)) * plotH;

  const mainPts = values.map((v, i) => [xAt(i), yAt(v)]);
  const avgPts = avgSeries.map((v, i) => [xAt(i), yAt(v)]);
  const mainPath = smoothSvgPath(mainPts);
  const avgPath = smoothSvgPath(avgPts);
  const areaPath = `${mainPath} L ${xAt(slots.length - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${xAt(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  // Vertical background hairlines (like Screenshot 1)
  const tickCount = 116;
  let bgTicks = '';
  for (let i = 0; i <= tickCount; i++) {
    const x = (padL + (i / tickCount) * plotW).toFixed(1);
    bgTicks += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" class="usage-bg-tick" />`;
  }

  // Y-axis steps (6 steps)
  let yAxisHtml = '';
  for (let s = 0; s <= 5; s++) {
    const val = (maxY / 5) * s;
    const y = yAt(val).toFixed(1);
    const label = val === 0 ? '0 B' : formatBytes(val);
    yAxisHtml += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="usage-grid-line" />`;
    yAxisHtml += `<text x="${padL - 10}" y="${Number(y) + 4}" text-anchor="end" class="usage-axis-label">${label}</text>`;
  }

  // X-axis labels
  const xAxisHtml = slots
    .map((s, i) =>
      s.shortLabel
        ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="usage-axis-label">${escapeHtml(s.shortLabel)}</text>`
        : ''
    )
    .join('');

  // Active point & floating callout card
  const activeSlot = slots[activeIdx] || slots[slots.length - 1];
  const activeVal = valOf(activeSlot);
  const prevVal = activeIdx > 0 ? valOf(slots[activeIdx - 1]) : activeVal;
  const vsAvgPct = avgVal > 0 ? Math.round(((activeVal - avgVal) / avgVal) * 100) : 0;
  const vsPrevPct = prevVal > 0 ? Math.round(((activeVal - prevVal) / prevVal) * 100) : 0;
  const activeX = xAt(activeIdx);
  const activeY = yAt(activeVal);
  const tooltipLeftPct = Math.min(78, Math.max(8, ((activeX - padL) / plotW) * 100));
  const tooltipTopPx = Math.min(plotH - 70, Math.max(18, activeY - 10));

  // Hero KPIs
  const totalSplit = splitBytes(periodTotal);
  const peakSplit = splitBytes(peakVal);
  const allTimeBytes = (store.data.totalDown || 0) + (store.data.totalUp || 0);
  const allTimeSplit = splitBytes(allTimeBytes);

  // Data Cap calculations
  const cap = h.dataCap || { enabled: false, period: 'monthly', limitBytes: 50 * 1024 ** 3, alertPct: 80, autoDisconnect: false };
  const nowKey = formatDayKey(Date.now());
  const monthPrefix = nowKey.slice(0, 7);
  const capUsedBytes =
    cap.period === 'daily'
      ? (h.days || []).find((d) => d.key === nowKey)
        ? ((h.days || []).find((d) => d.key === nowKey).upBytes || 0) + ((h.days || []).find((d) => d.key === nowKey).downBytes || 0)
        : allTimeBytes
      : (h.days || [])
          .filter((d) => d.key.startsWith(monthPrefix))
          .reduce((s, d) => s + (d.upBytes || 0) + (d.downBytes || 0), 0) || allTimeBytes;
  const capLimitBytes = Math.max(1, cap.limitBytes || 50 * 1024 ** 3);
  const capPct = Math.min(100, (capUsedBytes / capLimitBytes) * 100);
  const capLimitGb = Math.round((capLimitBytes / 1024 ** 3) * 10) / 10;

  // Download vs Upload ratio
  const downRatioPct = allTimeBytes > 0 ? (store.data.totalDown / allTimeBytes) * 100 : 100;
  const peakDownSplit = splitBytes(h.peakDownSpeed || 0);
  const peakUpSplit = splitBytes(h.peakUpSpeed || 0);

  // Per-server breakdown list (combining persisted perServer records + configured servers)
  const serverMap = new Map();
  for (const [id, rec] of Object.entries(h.perServer || {})) {
    serverMap.set(id, { ...rec, total: (rec.upBytes || 0) + (rec.downBytes || 0) });
  }
  for (const s of store.data.servers || []) {
    if (!serverMap.has(s.id)) {
      serverMap.set(s.id, {
        serverId: s.id,
        serverName: s.name,
        address: `${s.address}:${s.port}`,
        protocol: s.protocol,
        countryCode: s.geo?.countryCode || null,
        country: s.geo?.country || null,
        upBytes: 0,
        downBytes: 0,
        connectedSeconds: 0,
        sessions: 0,
        total: 0,
      });
    }
  }
  const serverRecords = [...serverMap.values()].sort((a, b) => b.total - a.total);
  const maxServerTotal = Math.max(1, ...serverRecords.map((r) => r.total));

  const serverRowsHtml = serverRecords.length
    ? serverRecords
        .map((r) => {
          const sharePct = allTimeBytes > 0 ? Math.round((r.total / allTimeBytes) * 100) : 0;
          const barW = r.total > 0 ? Math.max(4, Math.round((r.total / maxServerTotal) * 100)) : 0;
          return `<div class="usage-srv-row">
            <div class="usage-srv-main">
              ${flagHtml(r.countryCode, 28)}
              <div style="min-width:0;flex:1">
                <div class="usage-srv-name" title="${escapeHtml(r.serverName)}">${escapeHtml(r.serverName)}</div>
                <div class="usage-srv-sub">
                  <span class="mono">${escapeHtml(r.address)}</span>
                  <span>· ↓ ${formatBytes(r.downBytes)} · ↑ ${formatBytes(r.upBytes)}</span>
                  ${r.connectedSeconds > 0 ? `<span>· ${formatDuration(r.connectedSeconds * 1000)}</span>` : ''}
                </div>
              </div>
              <div class="usage-srv-right num">
                <span class="usage-delta is-up">▲ ${sharePct}%</span>
                <strong>${formatBytes(r.total)}</strong>
              </div>
            </div>
            <div class="usage-srv-bar"><i style="width:${barW}%"></i></div>
          </div>`;
        })
        .join('')
    : `<div class="empty"><strong>No server traffic recorded yet</strong><p>Connect to a server to track its bandwidth consumption.</p></div>`;

  const mainStroke = mode === 'up' ? '#5B7385' : '#F29E2E';

  root.innerHTML = `<div class="page usage-page">
    <div class="usage-top-bar">
      <div class="usage-period-wrap">
        <div>
          <h1 class="usage-title">Traffic Analytics</h1>
          <p class="usage-subtitle">Persistent bandwidth history, per-server telemetry & quota alerts</p>
        </div>
        <div class="usage-period-ctrl">
          <span class="usage-period-label">Time period:</span>
          <div class="usage-period-pills" role="group" aria-label="Time period">
            ${PERIODS.map((p) => `<button data-act="usage-period" data-period="${p.id}" class="${period === p.id ? 'is-active' : ''}" title="${p.title}">${p.label}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="usage-kpis">
        <div class="usage-kpi">
          <div class="usage-kpi-val num">${totalSplit.value}<small>${totalSplit.unit}</small></div>
          <div class="usage-kpi-label">Total usage (${PERIODS.find((p) => p.id === period)?.label})</div>
          <div class="usage-kpi-delta"><span class="usage-delta is-up">↓ ${formatBytes(periodDown)}</span><span class="muted">· ↑ ${formatBytes(periodUp)}</span></div>
        </div>
        <div class="usage-kpi">
          <div class="usage-kpi-val num">${peakSplit.value}<small>${peakSplit.unit}</small></div>
          <div class="usage-kpi-label">Peak slot consumption</div>
          <div class="usage-kpi-delta"><span class="usage-delta ${peakVal >= avgVal ? 'is-up' : 'is-down'}">${peakVal >= avgVal ? '▲' : '▼'} Avg ${formatBytes(avgVal)}</span></div>
        </div>
        <div class="usage-kpi">
          <div class="usage-kpi-val num">${allTimeSplit.value}<small>${allTimeSplit.unit}</small></div>
          <div class="usage-kpi-label">Persistent total usage</div>
          <div class="usage-kpi-delta"><span class="usage-delta is-up">▲ Saved on disk</span><button class="link-btn" data-act="usage-reset" title="Reset usage history">Reset</button></div>
        </div>
      </div>
    </div>

    <section class="panel usage-chart-card">
      <div class="usage-chart-head">
        <div class="usage-mode-pills" role="group" aria-label="Traffic metric">
          ${SERIES_MODES.map((m) => `<button data-act="usage-mode" data-mode="${m.id}" class="${mode === m.id ? 'is-active' : ''}">${m.label}</button>`).join('')}
        </div>
        <div class="usage-legend">
          <span><i class="legend-swatch" style="background:${mainStroke}"></i>${mode === 'combined' ? 'Current usage (↓+↑)' : mode === 'down' ? 'Download usage' : 'Upload usage'}</span>
          <span><i class="legend-swatch" style="background:#A3B1BC"></i>Rolling average</span>
        </div>
      </div>

      <div class="usage-chart-stage" data-ref="usageChartStage">
        <svg class="usage-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="usageAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${mainStroke}" stop-opacity="0.22" />
              <stop offset="100%" stop-color="${mainStroke}" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          ${bgTicks}
          ${yAxisHtml}
          <path d="${areaPath}" fill="url(#usageAreaGrad)" />
          <path d="${avgPath}" fill="none" stroke="#A3B1BC" stroke-width="2.1" stroke-linecap="round" />
          <path d="${mainPath}" fill="none" stroke="${mainStroke}" stroke-width="2.6" stroke-linecap="round" />
          <line data-ref="hoverLine" x1="${activeX.toFixed(1)}" y1="${padT}" x2="${activeX.toFixed(1)}" y2="${padT + plotH}" stroke="${mainStroke}" stroke-width="1.5" stroke-dasharray="3 2" />
          <circle data-ref="hoverDot" cx="${activeX.toFixed(1)}" cy="${activeY.toFixed(1)}" r="5.5" fill="${mainStroke}" stroke="var(--surface)" stroke-width="2.2" />
          ${xAxisHtml}
        </svg>

        <div class="usage-tooltip" data-ref="usageTooltip" style="left:${tooltipLeftPct.toFixed(1)}%;top:${tooltipTopPx.toFixed(0)}px">
          <div class="usage-tip-top">
            <span class="usage-tip-badge num" style="background:${mainStroke}">${formatBytes(activeVal)}</span>
            <span class="usage-tip-time">${escapeHtml(activeSlot.label)}</span>
          </div>
          <div class="usage-tip-breakdown num">↓ ${formatBytes(activeSlot.downBytes)} · ↑ ${formatBytes(activeSlot.upBytes)}</div>
          <div class="usage-tip-row">
            <span class="usage-delta ${vsAvgPct >= 0 ? 'is-up' : 'is-down'}">${vsAvgPct >= 0 ? '▲' : '▼'} ${vsAvgPct >= 0 ? '+' : ''}${vsAvgPct}%</span>
            <span>vs period average</span>
          </div>
          <div class="usage-tip-row">
            <span class="usage-delta ${vsPrevPct >= 0 ? 'is-up' : 'is-down'}">${vsPrevPct >= 0 ? '▲' : '▼'} ${vsPrevPct >= 0 ? '+' : ''}${vsPrevPct}%</span>
            <span>vs previous slot</span>
          </div>
        </div>
      </div>
    </section>

    <div class="usage-bottom-grid">
      <section class="panel usage-perf-card">
        <div class="usage-perf-head">
          <div>
            <h3>Data Cap & Quota</h3>
            <p>${cap.period === 'daily' ? 'Daily' : 'Monthly'} bandwidth limit & alert</p>
          </div>
          <button class="switch" role="switch" aria-checked="${!!cap.enabled}" aria-label="Enable data cap" data-act="cap-toggle"></button>
        </div>

        <div class="usage-perf-stat">
          <div class="usage-perf-pct num">${capPct.toFixed(1)}<small>%</small></div>
          <span class="usage-delta ${capPct >= cap.alertPct ? 'is-down' : 'is-up'}">${formatBytes(capUsedBytes)} / ${capLimitGb} GB</span>
        </div>

        ${renderSegmentedMeter(capPct, capPct >= 90 ? 'danger' : capPct >= cap.alertPct ? 'amber' : 'teal')}

        <div class="usage-cap-controls">
          <div class="row" style="justify-content:space-between">
            <span class="form-label">Quota period</span>
            <div class="segmented">
              <button data-act="cap-period" data-period="daily" aria-pressed="${cap.period === 'daily'}">Daily</button>
              <button data-act="cap-period" data-period="monthly" aria-pressed="${cap.period === 'monthly'}">Monthly</button>
            </div>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:8px">
            <span class="form-label">Cap limit</span>
            <div class="usage-cap-chips">
              ${CAP_PRESETS_GB.map((gb) => `<button class="cap-chip ${Math.abs(capLimitGb - gb) < 0.5 ? 'is-active' : ''}" data-act="cap-limit" data-gb="${gb}">${gb} GB</button>`).join('')}
            </div>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:8px">
            <span class="form-label" style="font-size:12px">Auto-disconnect VPN at 100%</span>
            <button class="switch" role="switch" aria-checked="${!!cap.autoDisconnect}" aria-label="Auto-disconnect at 100%" data-act="cap-autodisconnect"></button>
          </div>
        </div>
      </section>

      <section class="panel usage-perf-card">
        <div class="usage-perf-head">
          <div>
            <h3>Traffic Efficiency</h3>
            <p>Download vs upload ratio & peak throughput</p>
          </div>
          <span class="usage-circle-icon">${icon('zap', 16)}</span>
        </div>

        <div class="usage-perf-stat">
          <div class="usage-perf-pct num">${downRatioPct.toFixed(1)}<small>%</small></div>
          <span class="usage-delta is-up">▲ Download share</span>
        </div>

        ${renderSegmentedMeter(downRatioPct, 'amber')}

        <div class="usage-eff-rows">
          <div class="detail-row">
            <span class="detail-label">${icon('arrowDown', 14)}All-time download</span>
            <span class="detail-value num">${formatBytes(store.data.totalDown || 0)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">${icon('arrowUp', 14)}All-time upload</span>
            <span class="detail-value num">${formatBytes(store.data.totalUp || 0)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">${icon('gauge', 14)}Peak recorded speed</span>
            <span class="detail-value num">↓ ${peakDownSplit.value} ${peakDownSplit.unit}/s · ↑ ${peakUpSplit.value} ${peakUpSplit.unit}/s</span>
          </div>
        </div>
      </section>

      <section class="panel usage-perf-card usage-srv-card">
        <div class="usage-perf-head">
          <div>
            <h3>Per-Server Traffic</h3>
            <p>Cumulative usage across configured nodes</p>
          </div>
          <span class="usage-circle-icon">${icon('server', 16)}</span>
        </div>
        <div class="usage-srv-list">${serverRowsHtml}</div>
      </section>
    </div>
  </div>`;

  // Interactive hover scrubbing across the chart stage
  const stage = root.querySelector('[data-ref="usageChartStage"]');
  if (stage && slots.length > 1) {
    stage.onmousemove = (e) => {
      const rect = stage.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * W;
      const clamped = Math.max(padL, Math.min(W - padR, relX));
      const idx = Math.round(((clamped - padL) / plotW) * (slots.length - 1));
      if (idx !== store.usageHoverIdx && idx >= 0 && idx < slots.length) {
        store.usageHoverIdx = idx;
        renderUsage(root, store);
      }
    };
  }
}
