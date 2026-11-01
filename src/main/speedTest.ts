import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { lookupGeo } from './geo.ts';
import type { SpeedTestResult } from './types.ts';

const HOST = 'speed.cloudflare.com';
const DOWNLOAD_SECONDS = 10;
const UPLOAD_SECONDS = 8;
const STREAMS = 4;
const RAMP_UP_MS = 1500; // excluded from the final average (TCP slow start)
const LATENCY_SAMPLES = 12;

export type SpeedPhase = 'meta' | 'latency' | 'download' | 'upload';

export interface SpeedProgress {
  phase: SpeedPhase;
  /** Overall progress 0..1 across all phases. */
  progress: number;
  /** Live throughput for download/upload phases. */
  mbps?: number;
  partial: Partial<SpeedTestResult>;
}

type Measured = Omit<SpeedTestResult, 'id' | 'timestamp' | 'route' | 'serverName'>;

const PHASE_WEIGHT: Record<SpeedPhase, [number, number]> = {
  meta: [0, 0.04],
  latency: [0.04, 0.12],
  download: [0.12, 0.62],
  upload: [0.62, 1],
};

const mbps = (bytes: number, ms: number) => (ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Measures latency, download and upload against Cloudflare's speed-test edge.
 * When `proxyPort` is set every connection goes through the local Xray HTTP
 * proxy (CONNECT); otherwise sockets go out normally (which in TUN mode is
 * also through the tunnel).
 */
export class SpeedTest {
  private aborted = false;
  private sockets = new Set<tls.TLSSocket>();
  private agents = new Map<tls.TLSSocket, https.Agent>();
  private pendingConnections = new Set<() => void>();
  private readonly proxyPort: number | null;
  private readonly onProgress: (p: SpeedProgress) => void;

  constructor(proxyPort: number | null, onProgress: (p: SpeedProgress) => void) {
    this.proxyPort = proxyPort;
    this.onProgress = onProgress;
  }

  abort(): void {
    this.aborted = true;
    this.closeAll();
  }

  private checkAborted() {
    if (this.aborted) throw new Error('Speed test cancelled');
  }

  private report(phase: SpeedPhase, fraction: number, partial: Partial<SpeedTestResult>, live?: number) {
    const [a, b] = PHASE_WEIGHT[phase];
    this.onProgress({ phase, progress: a + (b - a) * Math.min(1, Math.max(0, fraction)), mbps: live, partial });
  }

  /** Opens a fresh TLS connection to the test host (through the proxy when configured). */
  private openTls(timeoutMs = 8000): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(new Error('Speed test cancelled'));
      let req: http.ClientRequest | undefined;
      let socket: tls.TLSSocket | undefined;
      let settled = false;
      const cancel = () => fail(new Error(this.aborted ? 'Speed test cancelled' : 'Connection closed'));
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingConnections.delete(cancel);
      };
      const timer = setTimeout(() => fail(new Error('Connection to the speed test server timed out')), timeoutMs);
      const finish = (sock: tls.TLSSocket) => {
        if (settled) { sock.destroy(); return; }
        settled = true;
        cleanup();
        this.sockets.add(sock);
        sock.once('close', () => this.sockets.delete(sock));
        resolve(sock);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        req?.destroy();
        socket?.destroy();
        reject(err);
      };
      this.pendingConnections.add(cancel);
      const tlsOpts = { servername: HOST, ALPNProtocols: ['http/1.1'] };
      if (!this.proxyPort) {
        socket = tls.connect({ host: HOST, port: 443, ...tlsOpts }, () => finish(socket!));
        socket.once('error', fail);
        return;
      }
      req = http.request({ host: '127.0.0.1', port: this.proxyPort, method: 'CONNECT', path: `${HOST}:443` });
      req.once('connect', (res, raw, head) => {
        if (settled) { raw.destroy(); return; }
        if (res.statusCode !== 200) {
          raw.destroy();
          fail(new Error(`Proxy refused the connection (HTTP ${res.statusCode})`));
          return;
        }
        if (head.length) raw.unshift(head);
        socket = tls.connect({ socket: raw, ...tlsOpts }, () => finish(socket!));
        socket.once('error', fail);
      });
      req.once('error', fail);
      req.end();
    });
  }

  private request(
    sock: tls.TLSSocket,
    method: string,
    path: string,
    headers: Record<string, string | number> = {}
  ): http.ClientRequest {
    this.checkAborted();
    let agent = this.agents.get(sock);
    if (!agent) {
      agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
      // agent:false creates a default Agent which ignores request.createConnection.
      // Own the Agent's connection factory so no request can open a direct socket.
      agent.createConnection = () => {
        if (sock.destroyed) throw new Error('Speed test connection is closed');
        return sock;
      };
      this.agents.set(sock, agent);
      sock.once('close', () => {
        agent!.destroy();
        this.agents.delete(sock);
      });
    }
    return https.request({
      host: HOST,
      method,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://speed.cloudflare.com/',
        Origin: 'https://speed.cloudflare.com',
        Accept: '*/*',
        ...headers,
      },
      agent,
    });
  }

  async run(): Promise<Measured> {
    const result: Measured = {
      downloadMbps: null,
      uploadMbps: null,
      pingMs: null,
      jitterMs: null,
      handshakeMs: null,
      ip: null,
      city: null,
      country: null,
      countryCode: null,
      isp: null,
      colo: null,
    };

    try {
      await this.measureMeta(result);
      this.checkAborted();
      await this.measureLatency(result);
      this.checkAborted();
      result.downloadMbps = await this.measureDownload(result);
      this.checkAborted();
      result.uploadMbps = await this.measureUpload(result);
      return result;
    } finally {
      this.closeAll();
    }
  }

  // ---------------------------------------------------------------- meta

  private async measureMeta(result: Measured) {
    this.report('meta', 0, result);
    const sock = await this.openTls();
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = this.request(sock, 'GET', '/meta');
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.once('error', reject);
      req.end();
    });
    sock.destroy();
    if (status === 200) {
      try {
        const meta = JSON.parse(body) as Record<string, unknown>;
        result.ip = typeof meta.clientIp === 'string' ? meta.clientIp : null;
        result.countryCode = typeof meta.country === 'string' ? meta.country.toUpperCase() : null;
        result.country = countryName(result.countryCode);
        result.city = typeof meta.city === 'string' ? meta.city : null;
        result.isp = typeof meta.asOrganization === 'string' ? meta.asOrganization : null;
        result.colo = typeof meta.colo === 'string' ? meta.colo : null;
      } catch {
        // Fallback below
      }
    }

    if (!result.ip || !result.colo) {
      try {
        const traceSock = await this.openTls();
        const traceBody = await new Promise<string>((resolve, reject) => {
          const req = this.request(traceSock, 'GET', '/cdn-cgi/trace');
          req.once('response', (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          });
          req.once('error', reject);
          req.end();
        });
        traceSock.destroy();
        const kv = Object.fromEntries(
          traceBody
            .split('\n')
            .map((l) => l.trim().split('='))
            .filter((p) => p.length === 2)
        ) as Record<string, string>;
        if (!result.ip && kv.ip) result.ip = kv.ip;
        if (!result.colo && kv.colo) result.colo = kv.colo;
        if (!result.countryCode && kv.loc) {
          result.countryCode = kv.loc.toUpperCase();
          result.country = countryName(result.countryCode);
        }
      } catch {
        // Optional fallback
      }
    }

    if (result.ip && (!result.city || !result.country)) {
      const geo = await lookupGeo(result.ip);
      if (geo) {
        if (!result.city && geo.city) result.city = geo.city;
        if (!result.country && geo.country) result.country = geo.country;
        if (!result.countryCode && geo.countryCode) result.countryCode = geo.countryCode;
      }
    }

    this.report('meta', 1, result);
  }

  // ---------------------------------------------------------------- latency

  /** Idle round-trip time: tiny requests reusing one keep-alive connection. */
  private async measureLatency(result: Measured) {
    const handshakes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const s = await this.openTls();
      handshakes.push(performance.now() - t0);
      s.destroy();
    }
    result.handshakeMs = Math.round(median(handshakes));

    const sock = await this.openTls();
    const rtts: number[] = [];
    try {
      for (let i = 0; i < LATENCY_SAMPLES; i++) {
        this.checkAborted();
        rtts.push(await rawRoundTrip(sock));
        const warm = rtts.slice(1); // first sample includes server warm-up
        if (warm.length) {
          result.pingMs = Math.round(median(warm));
          result.jitterMs = warm.length > 1 ? Math.round(meanAbsDiff(warm) * 10) / 10 : 0;
        }
        this.report('latency', (i + 1) / LATENCY_SAMPLES, result);
      }
    } finally {
      sock.destroy();
    }
  }

  // ---------------------------------------------------------------- download

  private async measureDownload(result: Measured): Promise<number> {
    const start = performance.now();
    const deadline = start + DOWNLOAD_SECONDS * 1000;
    let total = 0;
    let atRampEnd = -1;

    const stream = async () => {
      while (!this.aborted && performance.now() < deadline) {
        const sock = await this.openTls();
        await new Promise<void>((resolve) => {
          const req = this.request(sock, 'GET', '/__down?bytes=25000000');
          req.once('response', (res) => {
            if (res.statusCode === 200) {
              res.on('data', (c: Buffer) => (total += c.length));
            } else {
              res.resume();
            }
            res.once('end', resolve);
            res.once('error', () => resolve());
          });
          req.once('error', () => resolve());
          sock.once('close', () => resolve());
          req.end();
        });
        sock.destroy();
      }
    };

    const sampler = this.sample('download', start, DOWNLOAD_SECONDS, () => total, result, (bytes) => {
      if (atRampEnd < 0 && performance.now() - start >= RAMP_UP_MS) atRampEnd = bytes;
    });
    const stopAll = setTimeout(() => this.closeAll(), DOWNLOAD_SECONDS * 1000);
    await Promise.all(Array.from({ length: STREAMS }, () => stream().catch(() => undefined)));
    clearTimeout(stopAll);
    clearInterval(sampler);
    this.checkAborted();

    const elapsed = Math.min(performance.now(), deadline) - start;
    if (total === 0) throw new Error('Download test received no data');
    const value = mbps(total - Math.max(0, atRampEnd), elapsed - (atRampEnd >= 0 ? RAMP_UP_MS : 0));
    result.downloadMbps = Math.round(value * 10) / 10;
    this.report('download', 1, result, result.downloadMbps);
    return result.downloadMbps;
  }

  // ---------------------------------------------------------------- upload

  private async measureUpload(result: Measured): Promise<number> {
    const start = performance.now();
    const deadline = start + UPLOAD_SECONDS * 1000;
    const payload = crypto.randomBytes(2 * 1024 * 1024);
    let total = 0;
    let atRampEnd = -1;

    const stream = async () => {
      while (!this.aborted && performance.now() < deadline) {
        const sock = await this.openTls();
        try {
          while (!this.aborted && !sock.destroyed && performance.now() < deadline) {
            const ok = await new Promise<boolean>((resolve) => {
              const onClose = () => resolve(false);
              sock.once('close', onClose);
              const done = (v: boolean) => {
                sock.off('close', onClose);
                resolve(v);
              };
              const req = this.request(sock, 'POST', '/__up', {
                'Content-Type': 'application/octet-stream',
                'Content-Length': payload.length,
                Connection: 'keep-alive',
              });
              req.once('response', (res) => {
                res.resume();
                res.once('end', () => {
                  if (res.statusCode === 200) total += payload.length;
                  done(res.statusCode === 200);
                });
                res.once('error', () => done(false));
              });
              req.once('error', () => done(false));
              req.end(payload);
            });
            if (!ok) break;
          }
        } finally {
          sock.destroy();
        }
      }
    };

    const sampler = this.sample('upload', start, UPLOAD_SECONDS, () => total, result, (bytes) => {
      if (atRampEnd < 0 && performance.now() - start >= RAMP_UP_MS) atRampEnd = bytes;
    });
    const stopAll = setTimeout(() => this.closeAll(), UPLOAD_SECONDS * 1000);
    await Promise.all(Array.from({ length: STREAMS }, () => stream().catch(() => undefined)));
    clearTimeout(stopAll);
    clearInterval(sampler);
    this.checkAborted();

    const elapsed = Math.min(performance.now(), deadline) - start;
    if (total === 0) throw new Error('Upload test could not send data');
    const value = mbps(total - Math.max(0, atRampEnd), elapsed - (atRampEnd >= 0 ? RAMP_UP_MS : 0));
    result.uploadMbps = Math.round(value * 10) / 10;
    this.report('upload', 1, result, result.uploadMbps);
    return result.uploadMbps;
  }

  /** Emits live throughput (1-second sliding window) every 250 ms. */
  private sample(
    phase: SpeedPhase,
    start: number,
    seconds: number,
    bytes: () => number,
    result: Measured,
    onTick: (bytes: number) => void
  ): NodeJS.Timeout {
    const window: Array<[number, number]> = [[start, 0]];
    return setInterval(() => {
      const now = performance.now();
      const b = bytes();
      onTick(b);
      window.push([now, b]);
      while (window.length > 2 && now - window[0][0] > 1000) window.shift();
      const [t0, b0] = window[0];
      this.report(phase, (now - start) / (seconds * 1000), result, Math.round(mbps(b - b0, now - t0) * 10) / 10);
    }, 250);
  }

  private closeAll() {
    for (const cancel of this.pendingConnections) cancel();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
  }
}

function meanAbsDiff(xs: number[]): number {
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return sum / (xs.length - 1);
}

/** One HTTP/1.1 request on an existing keep-alive socket; resolves with the round-trip ms. */
function rawRoundTrip(sock: tls.TLSSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t0 = performance.now();
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buf.subarray(0, headerEnd).toString('latin1');
      const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      if (buf.length - headerEnd - 4 < len) return;
      cleanup();
      resolve(performance.now() - t0);
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connection closed during latency test'));
    };
    const cleanup = () => {
      sock.off('data', onData);
      sock.off('error', onErr);
      sock.off('close', onClose);
    };
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('close', onClose);
    sock.write(`GET /__down?bytes=0 HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: Xray-VPN-Client/1.0\r\nConnection: keep-alive\r\n\r\n`);
  });
}
