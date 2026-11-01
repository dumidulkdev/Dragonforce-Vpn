import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

/** A CONNECT response alone does not prove blocking; require the matching Xray access-log route. */
export async function verifyAdBlock(httpPort: number, accessLogPath: string, targets: string[], timeoutMs = 3000) {
  let offset = 0;
  try { offset = fs.statSync(accessLogPath).size; } catch { /* Xray may not have created its first log line. */ }
  const deadline = Date.now() + timeoutMs;
  const probes = await Promise.all(targets.map(host => new Promise<{ host: string; port: number }>((resolve) => {
    let port = 0;
    let finished = false;
    const req = http.request({ host: '127.0.0.1', port: httpPort, method: 'CONNECT', path: `${host}:443`, agent: false });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ host, port });
    };
    const timer = setTimeout(finish, Math.min(1500, timeoutMs));
    req.once('socket', socket => {
      if (!socket.connecting) port = socket.localPort || 0;
      else socket.once('connect', () => { port = socket.localPort || 0; });
    });
    req.once('connect', (_response, socket) => { port = socket.localPort || port; socket.destroy(); finish(); });
    req.once('error', finish);
    req.end();
  })));
  const verified = new Set<string>();
  do {
    let fd: number | undefined;
    try {
      fd = fs.openSync(accessLogPath, 'r');
      const size = fs.fstatSync(fd).size;
      const start = size < offset ? 0 : offset;
      const bytes = Buffer.alloc(Math.min(Math.max(0, size - start), 1024 * 1024));
      const read = fs.readSync(fd, bytes, 0, bytes.length, start);
      for (const line of bytes.subarray(0, read).toString('utf8').split(/\r?\n/)) {
        const match = line.match(/from (?:tcp:)?127\.0\.0\.1:(\d+)\s+accepted\s+(?:tcp:|\/\/)?([^\s/:]+):443\s+\[http-in\s*->\s*adblock\]/i);
        if (match && probes.some(probe => probe.port === Number(match[1]) && probe.host === match[2])) verified.add(match[2]);
      }
    } catch { /* Missing/unreadable logs cannot establish verification. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (verified.size === targets.length || Date.now() >= deadline) break;
    await delay(50);
  } while (true);
  const unverifiedTargets = targets.filter(host => !verified.has(host));
  const ok = targets.length > 0 && unverifiedTargets.length === 0;
  return {
    ok, blockedCount: verified.size, targets, verifiedTargets: [...verified], unverifiedTargets,
    error: ok ? undefined : `Could not verify blocking for ${unverifiedTargets.length} target(s) in Xray's access log.`,
  };
}
