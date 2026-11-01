import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { detectPhysicalGateway } from './tunManager.ts';
import type { ServerNode, ServerPingResult } from './types.ts';

export interface TcpPingOptions {
  timeoutMs?: number;
  localAddress?: string;
  localAddress6?: string;
  dnsServers?: string[];
}

type Address = { address: string; family: number };
type Sample = { ms: number; code?: string };
const pending = new WeakMap<ServerNode, symbol>();
let routeLookup: Promise<TcpPingOptions> | undefined;

/** Binding the source on Windows bypasses Wintun's locally acknowledged TCP handshake. */
export async function getDirectPingOptions(): Promise<TcpPingOptions> {
  if (process.platform !== 'win32') return {};
  if (!routeLookup) {
    routeLookup = (async () => {
      const route = await detectPhysicalGateway();
      const addresses = os.networkInterfaces()[route.interfaceName] || [];
      const localAddress = addresses.find((a) => a.family === 'IPv4' && !a.internal)?.address;
      const localAddress6 = addresses.find(
        (a) => a.family === 'IPv6' && !a.internal && !a.address.toLowerCase().startsWith('fe80:')
      )?.address;
      if (!localAddress && !localAddress6) {
        throw new Error('No usable address on the physical network adapter');
      }
      // The physical gateway is often the LAN DNS server. Prefer it when it is configured.
      const dnsServers = dns.getServers().sort((a, b) => Number(b === route.gatewayIp) - Number(a === route.gatewayIp));
      return { localAddress, localAddress6, dnsServers };
    })().finally(() => { routeLookup = undefined; });
  }
  return routeLookup;
}

async function resolveAddresses(host: string, options: TcpPingOptions, timeoutMs: number): Promise<Address[]> {
  const family = net.isIP(host);
  if (family) return [{ address: host, family }];

  const candidates: Promise<Address[]>[] = [dns.lookup(host, { all: true })];
  let resolver: dns.Resolver | undefined;
  // OS DNS can stall when TUN is up. Also query the configured DNS servers via the physical adapter.
  if (options.localAddress && options.dnsServers?.length) {
    resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers(options.dnsServers);
    resolver.setLocalAddress(options.localAddress, options.localAddress6);
    candidates.push(resolver.resolve4(host).then((ips) => ips.map((address) => ({ address, family: 4 }))));
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      Promise.any(candidates.map(async (candidate) => {
        const records = await candidate;
        if (!records.length) throw new Error('No addresses found');
        return records;
      })),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
      }),
    ]);
    return [...new Map(addresses.map((a) => [a.address, a])).values()].sort((a, b) => a.family - b.family);
  } finally {
    clearTimeout(timer);
    resolver?.cancel();
  }
}

function tcpSample(address: Address, port: number, timeoutMs: number, options: TcpPingOptions): Promise<Sample> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = performance.now();
    let settled = false;
    const finish = (result: Sample) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // A wall-clock deadline also covers a stalled connect, unlike an idle socket timeout.
    const timer = setTimeout(() => finish({ ms: -1, code: 'ETIMEDOUT' }), timeoutMs);
    socket.once('connect', () => finish({ ms: performance.now() - start }));
    socket.once('error', (err: NodeJS.ErrnoException) => finish({ ms: -1, code: err.code || 'UNKNOWN' }));
    const loopback = address.address.startsWith('127.') || address.address === '::1';
    const localAddress = loopback ? undefined : address.family === 4 ? options.localAddress : options.localAddress6;
    try {
      socket.connect({ host: address.address, port, family: address.family, localAddress });
    } catch (err) {
      finish({ ms: -1, code: (err as NodeJS.ErrnoException).code || 'UNKNOWN' });
    }
  });
}

function failedPing(pingStatus: ServerPingResult['pingStatus'], pingError: string): ServerPingResult {
  return { ping: -1, pingStatus, pingError, pingCheckedAt: Date.now() };
}

/** Median of up to three real TCP handshakes; DNS and adapter discovery are excluded from the RTT. */
export async function pingServerTcp(host: string, port: number, options: TcpPingOptions = {}): Promise<ServerPingResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failedPing('error', 'Invalid server address, port, or probe timeout');
  }

  let addresses: Address[];
  try {
    addresses = await resolveAddresses(host, options, Math.min(3000, remaining()));
  } catch (err) {
    const cause = err instanceof AggregateError ? err.errors[0] : err;
    const message = cause instanceof Error ? cause.message : String(cause);
    return failedPing('dns-error', `Could not resolve the server hostname: ${message}`);
  }

  const samples: number[] = [];
  let winner: Address | undefined;
  let errorCode = 'ETIMEDOUT';
  for (const address of addresses) {
    if (remaining() <= 0) break;
    const sample = await tcpSample(address, port, Math.min(3000, remaining()), options);
    if (sample.ms >= 0) {
      winner = address;
      samples.push(sample.ms);
      break;
    }
    errorCode = sample.code || errorCode;
  }
  while (winner && samples.length < 3 && remaining() > 0) {
    const sample = await tcpSample(winner, port, Math.min(3000, remaining()), options);
    if (sample.ms < 0) break;
    samples.push(sample.ms);
  }
  if (samples.length) {
    samples.sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
    return { ping: Math.max(1, Math.round(median)), pingStatus: 'ok', pingCheckedAt: Date.now() };
  }
  if (errorCode === 'ECONNREFUSED') return failedPing('refused', 'The server refused the TCP connection on this port');
  if (errorCode === 'ETIMEDOUT') return failedPing('timeout', 'The server did not complete a TCP handshake before the deadline');
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(errorCode)) {
    return failedPing('unreachable', `No usable network route to the server (${errorCode})`);
  }
  return failedPing('error', `TCP probe failed (${errorCode})`);
}

/** Discard old measurements and invalidate any result still in flight for this node. */
export function clearServerPing(node: ServerNode): void {
  pending.delete(node);
  node.ping = null;
  delete node.pingStatus;
  delete node.pingError;
  delete node.pingCheckedAt;
}

/** Bounded, endpoint-deduplicated batches with incremental UI updates and latest-request-wins results. */
export async function measureServerPings(
  nodes: ServerNode[],
  onUpdate: () => void,
  options?: TcpPingOptions
): Promise<void> {
  if (!nodes.length) return;
  const token = Symbol();
  const groups = new Map<string, { host: string; port: number; nodes: ServerNode[] }>();
  for (const node of nodes) {
    clearServerPing(node);
    pending.set(node, token);
    node.pingStatus = 'measuring';
    const key = JSON.stringify([node.address.toLowerCase(), node.port]);
    const group = groups.get(key) || { host: node.address, port: node.port, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  onUpdate();

  let context = options;
  let routeError: ServerPingResult | undefined;
  try {
    context ??= await getDirectPingOptions();
  } catch (err) {
    routeError = failedPing('unreachable', err instanceof Error ? err.message : String(err));
  }
  const queue = [...groups.values()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (cursor < queue.length) {
      const group = queue[cursor++];
      const result = routeError || await pingServerTcp(group.host, group.port, context);
      let changed = false;
      for (const node of group.nodes) {
        if (pending.get(node) !== token || node.address.toLowerCase() !== group.host.toLowerCase() || node.port !== group.port) continue;
        pending.delete(node);
        Object.assign(node, result);
        changed = true;
      }
      if (changed) onUpdate();
    }
  }));
}
