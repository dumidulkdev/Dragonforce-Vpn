/**
 * Builds public/assets/world-dots.json from Natural Earth 110m country polygons.
 *
 * Output is a compact equirectangular grid: each cell is 0 (sea) or the 1-based
 * index of the country whose polygon contains the cell centre. The renderer turns
 * every land cell into a dot, and can tint the dots of a specific country.
 *
 * Usage: node scripts/build-world-dots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, 'data', 'countries.geojson');
const outPath = path.resolve(__dirname, '..', 'public', 'assets', 'world-dots.json');

const STEP = 1; // degrees per cell
const LAT_TOP = 83;
const LAT_BOTTOM = -56; // exclude Antarctica
const cols = Math.round(360 / STEP);
const rows = Math.round((LAT_TOP - LAT_BOTTOM) / STEP);

const geo = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));

function isoOf(props) {
  for (const key of ['ISO_A2', 'ISO_A2_EH', 'WB_A2']) {
    const v = props[key];
    if (typeof v === 'string' && /^[A-Z]{2}$/.test(v)) return v;
  }
  return null;
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContains(poly, x, y) {
  if (!ringContains(poly[0], x, y)) return false;
  for (let h = 1; h < poly.length; h++) {
    if (ringContains(poly[h], x, y)) return false;
  }
  return true;
}

const countries = [];
const shapes = [];

for (const feature of geo.features) {
  const iso = isoOf(feature.properties);
  if (!iso || iso === 'AQ') continue;
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  let idx = countries.indexOf(iso);
  if (idx === -1) {
    countries.push(iso);
    idx = countries.length - 1;
  }
  for (const poly of polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    shapes.push({ idx, poly, minX, minY, maxX, maxY });
  }
}

const grid = new Uint8Array(cols * rows);
let land = 0;
for (let r = 0; r < rows; r++) {
  const lat = LAT_TOP - STEP * (r + 0.5);
  for (let c = 0; c < cols; c++) {
    const lon = -180 + STEP * (c + 0.5);
    for (const s of shapes) {
      if (lon < s.minX || lon > s.maxX || lat < s.minY || lat > s.maxY) continue;
      if (polygonContains(s.poly, lon, lat)) {
        grid[r * cols + c] = s.idx + 1;
        land++;
        break;
      }
    }
  }
}

const out = {
  source: 'Natural Earth 1:110m admin-0 countries (public domain)',
  step: STEP,
  latTop: LAT_TOP,
  latBottom: LAT_BOTTOM,
  cols,
  rows,
  countries,
  cells: Buffer.from(grid).toString('base64'),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`world-dots.json: ${cols}x${rows} grid, ${land} land dots, ${countries.length} countries`);
