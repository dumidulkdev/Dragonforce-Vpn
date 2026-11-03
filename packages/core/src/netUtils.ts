/**
 * Platform-agnostic runtime helpers that work identically in Node.js 22+,
 * Electron, Android WebView (Capacitor), and modern browsers without
 * requiring `node:crypto`, `node:net`, `node:url`, or `Buffer`.
 */

/** Generates a RFC 4122 v4 UUID using the standard Web Crypto API. */
export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Encodes a UTF-8 string into standard Base64 without depending on Node Buffer. */
export function encodeBase64Utf8(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf-8').toString('base64');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/** Decodes standard or URL-safe Base64 into a UTF-8 string without depending on Node Buffer. */
export function decodeBase64Utf8(input: string): string {
  const cleaned = input.trim().replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + '='.repeat(padLen);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf-8');
  }
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Parses a dotted-quad IPv4 literal into 4 octets, or null if invalid. */
export function parseIpv4(input: string): [number, number, number, number] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(input)) return null;
  const parts = input.split('.');
  const out: number[] = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Parses an IPv6 literal (without zone ID) into 8 16-bit hextets, or null if invalid. */
export function parseIpv6(input: string): number[] | null {
  if (!input || input.includes('%') || !input.includes(':')) return null;
  let working = input.toLowerCase();

  // Handle embedded IPv4 tail (e.g. ::ffff:192.0.2.128)
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups = side.split(':');
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      nums.push(parseInt(g, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSide(doubleColonParts[0]);
    const right = parseSide(doubleColonParts[1]);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array(missing).fill(0), ...right];
  }

  const full = parseSide(working);
  if (!full || full.length !== 8) return null;
  return full;
}

/** Mirrors `net.isIP`: returns 4 for IPv4, 6 for IPv6, or 0 for non-IP strings. */
export function ipFamily(input: string): 0 | 4 | 6 {
  if (parseIpv4(input)) return 4;
  if (parseIpv6(input)) return 6;
  return 0;
}

/** Checks whether an IPv4 or IPv6 address falls inside a CIDR subnet (pure bitwise check). */
export function ipInCidr(ip: string, network: string, prefixLen: number): boolean {
  const v4Ip = parseIpv4(ip);
  const v4Net = parseIpv4(network);
  if (v4Ip && v4Net) {
    if (prefixLen < 0 || prefixLen > 32) return false;
    if (prefixLen === 0) return true;
    const ipInt = ((v4Ip[0] << 24) | (v4Ip[1] << 16) | (v4Ip[2] << 8) | v4Ip[3]) >>> 0;
    const netInt = ((v4Net[0] << 24) | (v4Net[1] << 16) | (v4Net[2] << 8) | v4Net[3]) >>> 0;
    const mask = prefixLen === 32 ? 0xffffffff : (~((1 << (32 - prefixLen)) - 1)) >>> 0;
    return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
  }

  const v6Ip = parseIpv6(ip);
  const v6Net = parseIpv6(network);
  if (v6Ip && v6Net) {
    if (prefixLen < 0 || prefixLen > 128) return false;
    let remaining = prefixLen;
    for (let i = 0; i < 8 && remaining > 0; i++) {
      const bits = Math.min(16, remaining);
      const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((v6Ip[i] & mask) !== (v6Net[i] & mask)) return false;
      remaining -= bits;
    }
    return true;
  }

  return false;
}

/** Converts a Unicode or ASCII hostname into Punycode ASCII using WHATWG URL. */
export function hostnameToAscii(address: string): string {
  try {
    const parsed = new URL(`http://${address}`);
    return parsed.hostname;
  } catch {
    return '';
  }
}
