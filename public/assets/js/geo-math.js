/**
 * Pure geometry helpers for the world map (no DOM access).
 * Shared by the browser UI and the Node verification suite.
 *
 * Projection: equirectangular. A "view" is { lon, lat, k } — the geographic
 * centre of the viewport and the zoom factor relative to the base scale.
 */

export const LAT_TOP = 83;
export const LAT_BOTTOM = -56;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

/** Wraps a longitude difference/value into [-180, 180). */
export function normalizeLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Pixels per degree at zoom 1 — the map always covers the stage. */
export function baseScale(width, height) {
  return Math.max(width / 360, height / (LAT_TOP - LAT_BOTTOM));
}

export function project(view, width, height, lon, lat) {
  const s = baseScale(width, height) * view.k;
  return {
    x: width / 2 + (lon - view.lon) * s,
    y: height / 2 + (view.lat - lat) * s,
  };
}

export function unproject(view, width, height, x, y) {
  const s = baseScale(width, height) * view.k;
  return {
    lon: view.lon + (x - width / 2) / s,
    lat: view.lat - (y - height / 2) / s,
  };
}

/** Keeps the map covering the stage vertically and wraps the longitude. */
export function clampView(view, width, height) {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k));
  const s = baseScale(width, height) * k;
  const half = height / 2 / s;
  const minLat = LAT_BOTTOM + half;
  const maxLat = LAT_TOP - half;
  const lat = minLat > maxLat ? (LAT_TOP + LAT_BOTTOM) / 2 : Math.min(maxLat, Math.max(minLat, view.lat));
  return { lon: normalizeLon(view.lon), lat, k };
}

/** Returns the copy of `lon` (±360) nearest to `refLon`, so routes never wrap the long way round. */
export function nearestLon(lon, refLon) {
  return refLon + normalizeLon(lon - refLon);
}

/** Zoom by `factor` keeping the geographic point under (x, y) fixed. */
export function zoomAt(view, width, height, x, y, factor) {
  const anchor = unproject(view, width, height, x, y);
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  const s = baseScale(width, height) * k;
  return clampView(
    {
      k,
      lon: anchor.lon - (x - width / 2) / s,
      lat: anchor.lat + (y - height / 2) / s,
    },
    width,
    height
  );
}

/**
 * View that frames the given points with comfortable regional context.
 * Points are unwrapped relative to the first one (date-line safe).
 */
export function fitView(points, width, height, { minLonSpan = 70, minLatSpan = 38, padding = 0.18 } = {}) {
  if (!points.length) return clampView({ lon: 20, lat: 20, k: 1 }, width, height);
  const ref = points[0].lon;
  const lons = points.map((p) => nearestLon(p.lon, ref));
  const lats = points.map((p) => p.lat);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lonSpan = Math.max(minLonSpan, (maxLon - minLon) * (1 + padding * 2));
  const latSpan = Math.max(minLatSpan, (maxLat - minLat) * (1 + padding * 2));
  const s0 = baseScale(width, height);
  const k = Math.min(width / (lonSpan * s0), height / (latSpan * s0));
  return clampView({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, k }, width, height);
}

/** Control point for a gentle arc that bows towards the top of the screen. */
export function arcControlPoint(p0, p1, bend = 0.28) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const d = Math.hypot(dx, dy) || 1;
  let nx = -dy / d;
  let ny = dx / d;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: (p0.x + p1.x) / 2 + nx * d * bend, y: (p0.y + p1.y) / 2 + ny * d * bend };
}

export function quadPoint(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** Great-circle distance in km (used for the route summary). */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Number of particles to show for a measured throughput (bytes/s).
 * Zero below ~0.5 KB/s so an idle tunnel never looks busy.
 */
export function particleCount(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 512) return 0;
  return Math.max(1, Math.min(6, Math.round(1 + Math.log10(bytesPerSec / 512) * 1.4)));
}

/**
 * Positions a floating card next to an anchor so it stays inside the stage.
 * Tries above-right, above-left, below-right, below-left, then clamps.
 */
export function placeCard(anchor, cardW, cardH, stageW, stageH, { gap = 16, pad = 12 } = {}) {
  const options = [
    { placement: 'top-right', left: anchor.x + gap, top: anchor.y - cardH - gap },
    { placement: 'top-left', left: anchor.x - cardW - gap, top: anchor.y - cardH - gap },
    { placement: 'bottom-right', left: anchor.x + gap, top: anchor.y + gap },
    { placement: 'bottom-left', left: anchor.x - cardW - gap, top: anchor.y + gap },
  ];
  const fits = (o) => o.left >= pad && o.top >= pad && o.left + cardW <= stageW - pad && o.top + cardH <= stageH - pad;
  const chosen = options.find(fits) || options[0];
  return {
    placement: chosen.placement,
    left: Math.min(Math.max(chosen.left, pad), Math.max(pad, stageW - cardW - pad)),
    top: Math.min(Math.max(chosen.top, pad), Math.max(pad, stageH - cardH - pad)),
  };
}
