import {
  MIN_ZOOM,
  arcControlPoint,
  baseScale,
  clampView,
  fitView,
  nearestLon,
  normalizeLon,
  particleCount,
  placeCard,
  project,
  quadPoint,
  zoomAt,
} from './geo-math.js';
import { icon } from './icons.js';

const C_LIGHT = {
  land: '#C9D2DA',
  landOrigin: '#95A5B3',
  landDest: 'rgba(0, 168, 150, 0.62)',
  landDestIdle: '#A7C6C2',
  teal: '#00A896',
  tealDeep: '#087E77',
  amber: '#C98A2B',
  coral: '#DB5F57',
  slate: '#5D6D7A',
  idle: '#9AA8B4',
  white: '#FFFFFF',
};

const C_DARK = {
  land: '#233242',
  landOrigin: '#4A637B',
  landDest: 'rgba(0, 191, 166, 0.68)',
  landDestIdle: '#1F5652',
  teal: '#00BFA6',
  tealDeep: '#2EE5CB',
  amber: '#F59E0B',
  coral: '#F87171',
  slate: '#8DA2B8',
  idle: '#4D6278',
  white: '#131D27',
};

function getMapColors() {
  return document.documentElement.dataset.theme === 'dark' ? C_DARK : C_LIGHT;
}

const ACTIVE_STATES = new Set(['connected', 'connecting', 'reconnecting']);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Light dotted world map with an origin → server route.
 *
 * - Dots layer is redrawn only when the view/highlight changes.
 * - FX layer (route, markers, particles) animates only while a connection is
 *   active, a tween/drag is running, and the window is visible.
 */
export class WorldMap {
  constructor(stage, { onSelect, onViewChange } = {}) {
    this.stage = stage;
    this.onSelect = onSelect || (() => {});
    this.onViewChange = onViewChange || (() => {});
    stage.classList.add('map-stage');
    stage.innerHTML = `
      <canvas class="map-layer" data-layer="dots"></canvas>
      <canvas class="map-layer" data-layer="fx"></canvas>
      <div class="map-overlay">
        <div class="map-origin" hidden>${icon('home', 15)}</div>
        <div class="map-dest-card" hidden></div>
        <div class="map-tip" hidden></div>
      </div>`;
    this.dotsCanvas = stage.querySelector('[data-layer="dots"]');
    this.fxCanvas = stage.querySelector('[data-layer="fx"]');
    this.dotsCtx = this.dotsCanvas.getContext('2d');
    this.fxCtx = this.fxCanvas.getContext('2d');
    this.originEl = stage.querySelector('.map-origin');
    this.cardEl = stage.querySelector('.map-dest-card');
    this.tipEl = stage.querySelector('.map-tip');

    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.view = { lon: 20, lat: 20, k: 1 };
    this.grid = null;
    this.state = {
      origin: null, // { lat, lon, countryCode, tip }
      markers: [], // [{ id, lat, lon, countryCode, tip }]
      selectedId: null,
      conn: 'disconnected',
      up: 0,
      down: 0,
      destCard: '',
    };
    this.hoverId = null;
    this.dotsDirty = true;
    this.fxDirty = true;
    this.tween = null;
    this.drag = null;
    this.raf = 0;
    this.smoothUp = 0;
    this.smoothDown = 0;
    this.cardHtml = '';
    this.fitKey = '';
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.onVisibility = () => this.requestFrame();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onThemeChange = () => {
      this.dotsDirty = true;
      this.fxDirty = true;
      this.requestFrame();
    };
    window.addEventListener('vpn-theme-change', this.onThemeChange);
    this.bindPointer();
  }

  async load(url) {
    const res = await fetch(url);
    const data = await res.json();
    const raw = atob(data.cells);
    const lons = [];
    const lats = [];
    const idx = [];
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        const v = raw.charCodeAt(r * data.cols + c);
        if (!v) continue;
        lons.push(-180 + data.step * (c + 0.5));
        lats.push(data.latTop - data.step * (r + 0.5));
        idx.push(v - 1);
      }
    }
    this.grid = {
      lons: Float32Array.from(lons),
      lats: Float32Array.from(lats),
      idx: Uint8Array.from(idx),
      countries: data.countries,
    };
    this.dotsDirty = true;
    this.requestFrame();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('vpn-theme-change', this.onThemeChange);
  }

  // ---------------------------------------------------------------- state

  setState(partial) {
    const prev = this.state;
    this.state = { ...prev, ...partial };
    const s = this.state;
    const dest = this.destination();
    const highlightKey = `${s.origin?.countryCode}|${dest?.countryCode}|${s.conn === 'connected'}`;
    if (highlightKey !== this.highlightKey) {
      this.highlightKey = highlightKey;
      this.dotsDirty = true;
    }
    if (s.destCard !== this.cardHtml) {
      this.cardHtml = s.destCard;
      this.cardEl.innerHTML = s.destCard;
    }
    const fitKey = `${s.selectedId}|${s.origin ? `${s.origin.lat},${s.origin.lon}` : ''}|${dest ? 1 : 0}`;
    if (fitKey !== this.fitKey && this.w) {
      this.fitKey = fitKey;
      this.focusRoute(!prev.markers.length && !prev.origin);
    }
    this.fxDirty = true;
    this.requestFrame();
  }

  destination() {
    return this.state.markers.find((m) => m.id === this.state.selectedId) || null;
  }

  // ---------------------------------------------------------------- view

  focusRoute(instant = false) {
    const pts = [];
    const dest = this.destination();
    if (this.state.origin) pts.push(this.state.origin);
    if (dest) pts.push(dest);
    if (!pts.length) pts.push(...this.state.markers);
    const target = fitView(pts, this.w, this.h);
    this.animateTo(target, instant ? 0 : 420);
  }

  resetView() {
    const lon = this.state.origin ? this.state.origin.lon + 20 : 20;
    this.animateTo(clampView({ lon, lat: 15, k: MIN_ZOOM }, this.w, this.h), 420);
  }

  zoomBy(factor) {
    const target = zoomAt(this.view, this.w, this.h, this.w / 2, this.h / 2, factor);
    this.animateTo(target, 240);
  }

  animateTo(target, duration) {
    if (!duration || this.reducedMotion) {
      this.tween = null;
      this.setView(target);
      return;
    }
    this.tween = { from: { ...this.view }, to: target, start: performance.now(), duration };
    this.requestFrame();
  }

  setView(view) {
    this.view = clampView(view, this.w, this.h);
    this.dotsDirty = true;
    this.fxDirty = true;
    this.onViewChange(this.view);
    this.requestFrame();
  }

  stepTween(now) {
    const tw = this.tween;
    if (!tw) return;
    const t = Math.min(1, (now - tw.start) / tw.duration);
    const e = easeInOut(t);
    const dLon = normalizeLon(tw.to.lon - tw.from.lon);
    this.setView({
      lon: tw.from.lon + dLon * e,
      lat: tw.from.lat + (tw.to.lat - tw.from.lat) * e,
      k: Math.exp(Math.log(tw.from.k) + (Math.log(tw.to.k) - Math.log(tw.from.k)) * e),
    });
    if (t >= 1) this.tween = null;
  }

  resize() {
    const rect = this.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of [this.dotsCanvas, this.fxCanvas]) {
      cv.width = Math.round(this.w * this.dpr);
      cv.height = Math.round(this.h * this.dpr);
      cv.style.width = `${this.w}px`;
      cv.style.height = `${this.h}px`;
    }
    if (!this.fitKey) {
      this.setState({});
    }
    this.setView(this.view);
  }

  // ---------------------------------------------------------------- input

  bindPointer() {
    const el = this.fxCanvas;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.drag = { x: e.offsetX, y: e.offsetY, moved: 0 };
      this.tween = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.offsetX - this.drag.x;
        const dy = e.offsetY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.x = e.offsetX;
        this.drag.y = e.offsetY;
        if (this.drag.moved > 3) {
          const s = baseScale(this.w, this.h) * this.view.k;
          this.setView({ ...this.view, lon: this.view.lon - dx / s, lat: this.view.lat + dy / s });
          el.style.cursor = 'grabbing';
        }
        return;
      }
      this.updateHover(e.offsetX, e.offsetY);
    });
    const end = (e) => {
      if (!this.drag) return;
      const click = this.drag.moved <= 3;
      this.drag = null;
      el.style.cursor = '';
      if (click) {
        const hit = this.hitTest(e.offsetX, e.offsetY);
        if (hit && hit !== 'origin') this.onSelect(hit);
      }
      this.updateHover(e.offsetX, e.offsetY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      if (!this.drag) this.setHover(null);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.tween = null;
        this.setView(zoomAt(this.view, this.w, this.h, e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)));
      },
      { passive: false }
    );
    el.addEventListener('dblclick', (e) => {
      this.animateTo(zoomAt(this.view, this.w, this.h, e.offsetX, e.offsetY, 1.8), 260);
    });
  }

  screenOf(p, refLon = this.view.lon) {
    return project(this.view, this.w, this.h, nearestLon(p.lon, refLon), p.lat);
  }

  hitTest(x, y) {
    let best = null;
    let bestD = 12;
    for (const m of this.state.markers) {
      const p = this.screenOf(m);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    if (this.state.origin) {
      const p = this.screenOf(this.state.origin);
      if (Math.hypot(p.x - x, p.y - y) < 16 && !best) best = 'origin';
    }
    return best;
  }

  updateHover(x, y) {
    this.setHover(this.hitTest(x, y));
  }

  setHover(id) {
    this.fxCanvas.style.cursor = id && id !== 'origin' ? 'pointer' : '';
    if (id === this.hoverId) return;
    this.hoverId = id;
    const target = id === 'origin' ? this.state.origin : this.state.markers.find((m) => m.id === id);
    if (!target || (id === this.state.selectedId && this.state.destCard)) {
      this.tipEl.hidden = true;
    } else {
      this.tipEl.innerHTML = target.tip || '';
      this.tipEl.hidden = !target.tip;
    }
    this.fxDirty = true;
    this.requestFrame();
  }

  // ---------------------------------------------------------------- render loop

  needsAnimation() {
    return (!this.reducedMotion && ACTIVE_STATES.has(this.state.conn) && this.destination()) || this.tween;
  }

  requestFrame() {
    if (this.raf || document.hidden) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(now) {
    this.raf = 0;
    if (!this.w) return;
    this.stepTween(now);
    if (this.dotsDirty && this.grid) {
      this.drawDots();
      this.dotsDirty = false;
    }
    const animating = this.needsAnimation();
    if (animating || this.fxDirty) {
      this.drawFx(now);
      this.fxDirty = false;
    }
    if (animating) this.requestFrame();
  }

  drawDots() {
    const ctx = this.dotsCtx;
    const { w, h, dpr, view, grid } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = baseScale(w, h) * view.k;
    const r = Math.min(2.2, Math.max(0.6, s * 0.24));
    const dest = this.destination();
    const originIdx = grid.countries.indexOf(this.state.origin?.countryCode);
    const destIdx = grid.countries.indexOf(dest?.countryCode);
    const paths = { base: new Path2D(), origin: new Path2D(), dest: new Path2D() };
    const lonHalf = w / 2 / s;
    const viewLeft = view.lon - lonHalf;
    const viewRight = view.lon + lonHalf;
    // Draw the world copy at -360/0/+360 that overlaps the viewport (date-line wrap).
    for (const offset of [-360, 0, 360]) {
      if (180 + offset < viewLeft || -180 + offset > viewRight) continue;
      for (let i = 0; i < grid.lons.length; i++) {
        const x = w / 2 + (grid.lons[i] + offset - view.lon) * s;
        if (x < -r || x > w + r) continue;
        const y = h / 2 + (view.lat - grid.lats[i]) * s;
        if (y < -r || y > h + r) continue;
        const c = grid.idx[i];
        const p = c === destIdx ? paths.dest : c === originIdx ? paths.origin : paths.base;
        p.moveTo(x + r, y);
        p.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    const C = getMapColors();
    ctx.fillStyle = C.land;
    ctx.fill(paths.base);
    ctx.fillStyle = C.landOrigin;
    ctx.fill(paths.origin);
    ctx.fillStyle = this.state.conn === 'connected' ? C.landDest : C.landDestIdle;
    ctx.fill(paths.dest);
  }

  drawFx(now) {
    const C = getMapColors();
    const ctx = this.fxCtx;
    const { w, h, dpr } = this;
    const st = this.state;
    const t = now / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const dest = this.destination();
    const origin = st.origin;
    const p0 = origin ? this.screenOf(origin) : null;
    const p1 = dest ? (origin ? project(this.view, w, h, nearestLon(dest.lon, nearestLon(origin.lon, this.view.lon)), dest.lat) : this.screenOf(dest)) : null;

    // Route
    if (p0 && p1) {
      const c = arcControlPoint(p0, p1);
      this.drawRoute(ctx, p0, c, p1, t);
    }

    // Other server markers
    for (const m of st.markers) {
      if (dest && m.id === dest.id) continue;
      const p = this.screenOf(m);
      if (p.x < -10 || p.x > w + 10 || p.y < -10 || p.y > h + 10) continue;
      const hovered = m.id === this.hoverId;
      ctx.beginPath();
      ctx.arc(p.x, p.y, hovered ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = C.white;
      ctx.fill();
      ctx.lineWidth = hovered ? 2 : 1.5;
      ctx.strokeStyle = hovered ? C.teal : C.idle;
      ctx.stroke();
    }

    // Destination marker
    if (p1) this.drawDestination(ctx, p1, t);

    // HTML overlays
    this.positionOverlays(p0, p1);
  }

  routeColor() {
    const C = getMapColors();
    switch (this.state.conn) {
      case 'connected':
        return C.teal;
      case 'connecting':
        return C.teal;
      case 'reconnecting':
        return C.amber;
      case 'error':
        return C.coral;
      default:
        return C.idle;
    }
  }

  drawRoute(ctx, p0, c, p1, t) {
    const conn = this.state.conn;
    const color = this.routeColor();
    const path = new Path2D();
    path.moveTo(p0.x, p0.y);
    path.quadraticCurveTo(c.x, c.y, p1.x, p1.y);

    ctx.save();
    ctx.lineCap = 'round';
    if (conn === 'connected') {
      ctx.strokeStyle = 'rgba(0, 168, 150, 0.14)';
      ctx.lineWidth = 6;
      ctx.stroke(path);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75;
      ctx.stroke(path);
    } else if (conn === 'connecting' || conn === 'reconnecting') {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = this.reducedMotion ? 0 : -t * 22;
      ctx.stroke(path);
      ctx.setLineDash([]);
      if (!this.reducedMotion) {
        // Progress sweep travelling towards the server while the handshake runs
        const head = (t * 0.55) % 1;
        for (let i = 0; i < 10; i++) {
          const tt = head - i * 0.012;
          if (tt < 0) break;
          const p = quadPoint(p0, c, p1, tt);
          ctx.globalAlpha = 0.9 * (1 - i / 10);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 - i * 0.12, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
      }
    } else {
      ctx.strokeStyle = color;
      ctx.globalAlpha = conn === 'error' ? 0.8 : 0.65;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 5]);
      ctx.stroke(path);
    }
    ctx.restore();

    if (conn === 'connected') this.drawParticles(ctx, p0, c, p1, t);
  }

  /** Particle density follows measured throughput; nothing moves on an idle tunnel. */
  drawParticles(ctx, p0, c, p1, t) {
    const C = getMapColors();
    this.smoothUp += (particleCount(this.state.up) - this.smoothUp) * 0.06;
    this.smoothDown += (particleCount(this.state.down) - this.smoothDown) * 0.06;
    const lanes = [
      { n: this.smoothUp, color: C.teal, reverse: false, speed: 0.26, seed: 0.13 },
      { n: this.smoothDown, color: C.tealDeep, reverse: true, speed: 0.3, seed: 0.61 },
    ];
    ctx.save();
    for (const lane of lanes) {
      const whole = Math.ceil(lane.n - 0.01);
      for (let i = 0; i < whole; i++) {
        const alpha = Math.min(1, lane.n - i);
        if (alpha <= 0.02) continue;
        const phase = (lane.seed + i / Math.max(whole, 1)) % 1;
        const base = this.reducedMotion ? phase : (phase + t * lane.speed) % 1;
        for (let k = 0; k < 4; k++) {
          let tt = base - k * 0.014;
          if (tt < 0) continue;
          const pos = quadPoint(p0, c, p1, lane.reverse ? 1 - tt : tt);
          ctx.globalAlpha = alpha * (k === 0 ? 1 : 0.45 - k * 0.1);
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, k === 0 ? 2.4 : 1.8 - k * 0.3, 0, Math.PI * 2);
          ctx.fillStyle = lane.color;
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  drawDestination(ctx, p, t) {
    const C = getMapColors();
    const conn = this.state.conn;
    const color =
      conn === 'connected' || conn === 'connecting'
        ? C.teal
        : conn === 'reconnecting'
          ? C.amber
          : conn === 'error'
            ? C.coral
            : C.slate;

    if (ACTIVE_STATES.has(conn) && !this.reducedMotion) {
      const period = conn === 'connected' ? 2.6 : 1.4;
      for (let i = 0; i < 2; i++) {
        const ph = ((t / period + i / 2) % 1 + 1) % 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7 + ph * 16, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35 * (1 - ph);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (conn === 'connected') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 168, 150, 0.14)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = conn === 'disconnected' ? C.white : color;
    ctx.fill();
    ctx.lineWidth = 2.25;
    ctx.strokeStyle = conn === 'disconnected' ? C.slate : C.white;
    ctx.stroke();
    if (conn === 'disconnected') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = C.slate;
      ctx.fill();
    }
  }

  positionOverlays(p0, p1) {
    const { w, h } = this;
    const inside = (p, m = 0) => p && p.x >= -m && p.x <= w + m && p.y >= -m && p.y <= h + m;

    if (inside(p0, 20)) {
      this.originEl.hidden = false;
      this.originEl.style.transform = `translate(${p0.x - 17}px, ${p0.y - 17}px)`;
      this.originEl.classList.toggle('is-live', this.state.conn === 'connected');
    } else {
      this.originEl.hidden = true;
    }

    if (inside(p1, 0) && this.cardHtml) {
      this.cardEl.hidden = false;
      const cw = this.cardEl.offsetWidth;
      const ch = this.cardEl.offsetHeight;
      const pos = placeCard(p1, cw, ch, w, h);
      this.cardEl.style.transform = `translate(${pos.left}px, ${pos.top}px)`;
      this.cardEl.dataset.placement = pos.placement;
    } else {
      this.cardEl.hidden = true;
    }

    if (!this.tipEl.hidden && this.hoverId) {
      const target = this.hoverId === 'origin' ? this.state.origin : this.state.markers.find((m) => m.id === this.hoverId);
      if (target) {
        const p = this.screenOf(target);
        const pos = placeCard(p, this.tipEl.offsetWidth, this.tipEl.offsetHeight, w, h, { gap: 12 });
        this.tipEl.style.transform = `translate(${pos.left}px, ${pos.top}px)`;
      }
    }
  }
}
