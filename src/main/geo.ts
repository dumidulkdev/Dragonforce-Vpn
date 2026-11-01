import http from 'node:http';
import type { GeoInfo } from './types.ts';

const IP_API_FIELDS = 'status,message,country,countryCode,city,lat,lon,query';

function toGeo(json: Record<string, unknown>): GeoInfo | null {
  if (json.status !== 'success') return null;
  const lat = Number(json.lat);
  const lon = Number(json.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    ip: String(json.query || ''),
    country: String(json.country || ''),
    countryCode: String(json.countryCode || '').toUpperCase(),
    city: String(json.city || ''),
    lat,
    lon,
  };
}

/**
 * Geo-locates an IP (or the caller's own public IP when `ip` is omitted).
 * Returns null on any failure — callers treat location as optional.
 */
export async function lookupGeo(ip?: string): Promise<GeoInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const target = ip ? encodeURIComponent(ip) : '';
    const res = await fetch(`http://ip-api.com/json/${target}?fields=${IP_API_FIELDS}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return toGeo((await res.json()) as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up the public exit IP as seen *through* the local Xray HTTP inbound,
 * i.e. the address websites observe while connected.
 */
export function lookupExitGeo(httpPort: number, timeoutMs = 7000): Promise<GeoInfo | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: httpPort,
        method: 'GET',
        path: `http://ip-api.com/json/?fields=${IP_API_FIELDS}`,
        headers: { Host: 'ip-api.com', 'User-Agent': 'Xray-VPN-Client/1.0' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(toGeo(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.once('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.once('error', () => resolve(null));
    req.end();
  });
}
