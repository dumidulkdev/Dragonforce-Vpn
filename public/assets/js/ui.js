/** Small, framework-free UI helpers shared by all views. */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Splits a byte count into a display value and unit, e.g. { value: '114.5', unit: 'KB' }. */
export function splitBytes(bytes) {
  if (!bytes || bytes <= 0) return { value: '0', unit: 'B' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return { value: v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1), unit: units[i] };
}

export function formatBytes(bytes) {
  const { value, unit } = splitBytes(bytes);
  return `${value} ${unit}`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function latencyTone(ms) {
  if (ms === null || ms === undefined) return 'none';
  if (ms < 0) return 'bad';
  if (ms < 120) return 'good';
  if (ms < 250) return 'fair';
  return 'bad';
}

export function latencyText(ms, status) {
  if (status === 'measuring') return 'Testing…';
  if (ms === null || ms === undefined) return '—';
  if (ms >= 0) return `${ms} ms`;
  return { timeout: 'Timeout', 'dns-error': 'DNS failed', refused: 'Refused', unreachable: 'No route' }[status] || 'Failed';
}

export function latencyTitle(node) {
  if (node.pingStatus === 'measuring') return 'Measuring TCP handshakes through the physical network adapter…';
  const measured = node.pingCheckedAt ? ` · Measured ${new Date(node.pingCheckedAt).toLocaleTimeString()}` : '';
  if (node.pingError) return `${node.pingError}${measured}`;
  return `Direct TCP handshake latency${measured}`;
}

/** Circular SVG flag (flagcdn) with a country-code fallback when offline. */
export function flagHtml(countryCode, size = 28) {
  const cc = String(countryCode || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) {
    return `<span class="flag is-fallback is-unknown" style="--flag:${size}px" aria-hidden="true"></span>`;
  }
  return `<span class="flag" style="--flag:${size}px" data-cc="${cc.toUpperCase()}" aria-hidden="true"><img src="https://flagcdn.com/${cc}.svg" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('is-fallback');this.remove()"></span>`;
}

export function locationLabel(geo) {
  if (!geo) return '';
  return [geo.city, geo.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
}

let toastTimer = 0;
export function toast(message, tone = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

export async function copyText(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success');
  } catch {
    toast('Clipboard is not available', 'error');
  }
}

/**
 * Lightweight sparkline renderer for a bounded sample history.
 * Draws nothing but a baseline when there is no traffic.
 */
export function drawSparkline(canvas, samples, color) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = rect.width;
  const h = rect.height;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#E8EDF0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  if (samples.length < 2) return;
  const max = Math.max(...samples, 1024);
  const step = w / (samples.length - 1);
  const pts = samples.map((v, i) => ({ x: i * step, y: h - 3 - (v / max) * (h - 8) }));

  const line = new Path2D();
  line.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1].x + pts[i].x) / 2;
    line.bezierCurveTo(mx, pts[i - 1].y, mx, pts[i].y, pts[i].x, pts[i].y);
  }
  const area = new Path2D(line);
  area.lineTo(w, h);
  area.lineTo(0, h);
  area.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `${color}26`);
  grad.addColorStop(1, `${color}00`);
  ctx.fillStyle = grad;
  ctx.fill(area);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke(line);
}
