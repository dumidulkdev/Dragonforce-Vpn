import crypto from 'node:crypto';
import type { NetworkType, SecurityType, ServerNode } from './types.ts';
import { normalizeServerAddress, parseServerPort } from './serverAddress.ts';

function decodeBase64Safe(input: string): string {
  const cleaned = input.trim().replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function normalizeNetwork(raw?: string): NetworkType {
  const val = (raw || 'tcp').toLowerCase().trim();
  if (val === 'ws' || val === 'websocket') return 'ws';
  if (val === 'grpc' || val === 'gun') return 'grpc';
  if (val === 'httpupgrade') return 'httpupgrade';
  if (val === 'xhttp' || val === 'splithttp') return 'xhttp';
  return 'tcp';
}

function normalizeSecurity(raw?: string): SecurityType {
  const val = (raw || 'none').toLowerCase().trim();
  if (val === 'tls' || val === 'xtls' || val === '1' || val === 'true' || val === 'ssl') {
    return 'tls';
  }
  if (val === 'reality') {
    return 'reality';
  }
  return 'none';
}

/** Share links may use "none" for no flow; Xray expects the field to be omitted. */
export function normalizeVlessFlow(raw?: string | null): string | undefined {
  const flow = raw?.trim();
  return !flow || flow.toLowerCase() === 'none' ? undefined : flow;
}

/** Older panels sometimes URI-encode an entire HTTP transport path twice. */
export function normalizeTransportPath(raw: string | undefined, network: NetworkType): string | undefined {
  if (raw && ['ws', 'httpupgrade', 'xhttp'].includes(network) && /^%2f/i.test(raw)) {
    try {
      // Only unwrap an encoded absolute path. A normal /path may contain
      // intentional escapes in path segments or query tokens; preserve those.
      return decodeURIComponent(raw);
    } catch {
      // Keep malformed/literal percent sequences rather than rejecting a link.
    }
  }
  return raw || (network === 'ws' ? '/' : undefined);
}

function parseAllowInsecure(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === 'string' && /^(1|true)$/i.test(value.trim()));
}

function readAllowInsecure(params: URLSearchParams): boolean {
  return parseAllowInsecure(params.get('allowInsecure') ?? params.get('insecure') ?? params.get('allow_insecure'));
}

export function parseVlessUri(uri: string, subscriptionId?: string): ServerNode {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('vless://')) {
    throw new Error('Invalid VLESS URI prefix');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Malformed VLESS URL: ${trimmed.slice(0, 48)}...`);
  }

  const uuid = decodeURIComponent(url.username);
  const address = normalizeServerAddress(url.hostname);
  const port = parseServerPort(url.port || 443);

  if (!uuid || !address || !port || Number.isNaN(port)) {
    throw new Error('VLESS link is missing UUID, host, or port');
  }

  const params = url.searchParams;
  const network = normalizeNetwork(params.get('type') || params.get('net') || 'tcp');
  const security = normalizeSecurity(params.get('security') || params.get('tls') || 'none');

  const sni = params.get('sni') || params.get('peer') || undefined;
  const host = params.get('host') || params.get('obfsParam') || undefined;
  const rawPath = params.get('path') || params.get('serviceName') || undefined;
  const path = normalizeTransportPath(rawPath, network);
  const headerType = params.get('headerType') || params.get('obfs') || 'none';
  const fingerprint = params.get('fp') || params.get('fingerprint') || 'chrome';
  const alpnRaw = params.get('alpn');
  const alpn = alpnRaw
    ? alpnRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const allowInsecure = readAllowInsecure(params);

  const encryption = params.get('encryption') || 'none';
  const flow = normalizeVlessFlow(params.get('flow'));
  const publicKey = params.get('pbk') || undefined;
  const shortId = params.get('sid') || undefined;
  const spiderX = params.get('spx') || undefined;

  const rawHash = url.hash ? url.hash.slice(1) : '';
  let name = `${address}:${port}`;
  if (rawHash) {
    try {
      name = decodeURIComponent(rawHash).trim() || name;
    } catch {
      name = rawHash.trim() || name;
    }
  }

  return {
    id: crypto.randomUUID(),
    name,
    protocol: 'vless',
    address,
    port,
    uuid,
    encryption,
    flow,
    network,
    headerType,
    host,
    path,
    security,
    sni: sni || (security !== 'none' ? host || address : undefined),
    alpn,
    fingerprint,
    allowInsecure,
    publicKey,
    shortId,
    spiderX,
    rawUri: trimmed,
    subscriptionId,
    ping: null,
  };
}

export function parseVmessUri(uri: string, subscriptionId?: string): ServerNode {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('vmess://')) {
    throw new Error('Invalid VMess URI prefix');
  }

  const body = trimmed.slice('vmess://'.length).trim();

  // Case 1: Standard v2rayN Base64 JSON format
  const decoded = decodeBase64Safe(body);
  if (decoded.trim().startsWith('{')) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(decoded);
    } catch {
      throw new Error('Malformed VMess JSON');
    }
    const address = normalizeServerAddress(String(json.add || json.address || ''));
    const port = parseServerPort(json.port === undefined ? 443 : json.port);
    const uuid = String(json.id || json.uuid || '').trim();
    if (!address || !port || !uuid) {
      throw new Error('VMess JSON missing add, port, or id');
    }

    const network = normalizeNetwork(String(json.net || 'tcp'));
    const security = normalizeSecurity(String(json.tls || json.security || 'none'));
    const host = json.host ? String(json.host).trim() : undefined;
    const path = normalizeTransportPath(json.path ? String(json.path).trim() : undefined, network);
    const sni = json.sni
      ? String(json.sni).trim()
      : security === 'tls'
        ? host || address
        : undefined;
    const alpnStr = json.alpn ? String(json.alpn) : '';
    const alpn = alpnStr
      ? alpnStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const allowInsecure = parseAllowInsecure(json.allowInsecure ?? json.insecure ?? json.allow_insecure);

    return {
      id: crypto.randomUUID(),
      name: String(json.ps || json.remarks || `${address}:${port}`).trim(),
      protocol: 'vmess',
      address,
      port,
      uuid,
      alterId: Number(json.aid || 0),
      cipher: String(json.scy || 'auto'),
      network,
      headerType: String(json.type || 'none'),
      host,
      path,
      security,
      sni,
      alpn,
      fingerprint: String(json.fp || 'chrome'),
      allowInsecure,
      rawUri: trimmed,
      subscriptionId,
      ping: null,
    };
  }

  // Case 2: URL-style vmess:// (e.g. vmess://uuid@host:port?... or base64 userinfo)
  let url: URL;
  try {
    const qIdx = body.indexOf('?');
    if (qIdx !== -1 && !body.slice(0, qIdx).includes('@')) {
      const decodedHead = decodeBase64Safe(body.slice(0, qIdx));
      url = new URL(`vmess://${decodedHead}${body.slice(qIdx)}`);
    } else {
      url = new URL(trimmed);
    }
  } catch {
    throw new Error('Malformed VMess link (neither valid Base64 JSON nor URL format)');
  }

  const rawUser = decodeURIComponent(url.username);
  const uuid = url.password ? decodeURIComponent(url.password) : rawUser;
  const cipher = url.password ? rawUser : 'auto';
  const address = normalizeServerAddress(url.hostname);
  const port = parseServerPort(url.port || 443);
  if (!uuid) throw new Error('VMess link is missing UUID');

  const params = url.searchParams;
  const network = normalizeNetwork(
    params.get('type') || params.get('net') || params.get('obfs') || 'tcp'
  );
  const security = normalizeSecurity(params.get('security') || params.get('tls') || 'none');
  const host = params.get('host') || params.get('obfsParam') || undefined;
  const path = normalizeTransportPath(params.get('path') || undefined, network);
  const sni = params.get('sni') || params.get('peer') || (security === 'tls' ? host || address : undefined);
  const name =
    params.get('remarks') ||
    (url.hash ? decodeURIComponent(url.hash.slice(1)) : '') ||
    `${address}:${port}`;

  return {
    id: crypto.randomUUID(),
    name,
    protocol: 'vmess',
    address,
    port,
    uuid,
    alterId: Number(params.get('aid') || 0),
    cipher,
    network,
    headerType: params.get('headerType') || 'none',
    host,
    path,
    security,
    sni,
    fingerprint: params.get('fp') || 'chrome',
    allowInsecure: readAllowInsecure(params),
    rawUri: trimmed,
    subscriptionId,
    ping: null,
  };
}

export function parseShareLink(uri: string, subscriptionId?: string): ServerNode {
  const trimmed = uri.trim();
  if (trimmed.toLowerCase().startsWith('vless://')) {
    return parseVlessUri(trimmed, subscriptionId);
  }
  if (trimmed.toLowerCase().startsWith('vmess://')) {
    return parseVmessUri(trimmed, subscriptionId);
  }
  throw new Error(`Unsupported link protocol (only vless:// and vmess:// are supported): ${trimmed.slice(0, 24)}`);
}

/**
 * Parses a block of text (or Base64 subscription payload) that may contain one or many vless:// / vmess:// links.
 */
export function parseMultipleLinks(input: string, subscriptionId?: string): {
  nodes: ServerNode[];
  errors: string[];
} {
  let content = input.trim();
  if (!content) {
    return { nodes: [], errors: ['Input is empty'] };
  }

  // If the entire payload doesn't start with vless:// or vmess://, try Base64 decoding it first
  if (
    !content.toLowerCase().includes('vless://') &&
    !content.toLowerCase().includes('vmess://')
  ) {
    try {
      const decoded = decodeBase64Safe(content);
      if (
        decoded.toLowerCase().includes('vless://') ||
        decoded.toLowerCase().includes('vmess://')
      ) {
        content = decoded;
      }
    } catch {
      // Keep original content
    }
  }

  const lines = content
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const nodes: ServerNode[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    if (
      !line.toLowerCase().startsWith('vless://') &&
      !line.toLowerCase().startsWith('vmess://')
    ) {
      continue;
    }
    try {
      nodes.push(parseShareLink(line, subscriptionId));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { nodes, errors };
}
