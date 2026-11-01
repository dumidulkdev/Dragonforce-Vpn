import crypto from 'node:crypto';
import type http from 'node:http';

export function validateLocalRequest(req: http.IncomingMessage, port: number, token: string): { status: number; error: string } | null {
  const host = req.headers.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 403, error: 'Untrusted Host header' };
  }
  if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
    return { status: 403, error: 'Cross-origin requests are not allowed' };
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return { status: 415, error: 'Use application/json for API requests' };
    }
    const supplied = req.headers['x-dragonforce-token'];
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      return { status: 403, error: 'Invalid session token. Reload the app.' };
    }
  }
  return null;
}
