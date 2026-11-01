import type { NetworkType, SecurityType, ServerNode } from './types.ts';
import { normalizeServerAddress, parseServerPort } from './serverAddress.ts';
import { normalizeTransportPath } from './parser.ts';

/**
 * Editing support for server nodes: validated patching and share-link
 * serialisation (so "Copy link" and exports reflect user edits).
 */

const NETWORKS: NetworkType[] = ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'];
const SECURITIES: SecurityType[] = ['none', 'tls', 'reality'];

/** Fields the editor is allowed to change. */
export interface ServerEdit {
  name?: string;
  address?: string;
  port?: number | string;
  uuid?: string;
  network?: string;
  headerType?: string;
  host?: string;
  path?: string;
  security?: string;
  sni?: string;
  alpn?: string | string[];
  fingerprint?: string;
  allowInsecure?: boolean;
  flow?: string;
  encryption?: string;
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
  alterId?: number | string;
  cipher?: string;
}

const optional = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : undefined;
};

/**
 * Returns a new node with the edit applied. Throws an Error with a
 * user-readable message when a value is invalid.
 */
export function applyServerEdit(node: ServerNode, edit: ServerEdit): ServerNode {
  const next: ServerNode = { ...node };
  const has = (k: keyof ServerEdit) => Object.prototype.hasOwnProperty.call(edit, k);

  if (has('name')) {
    const name = optional(edit.name);
    if (!name) throw new Error('Remarks cannot be empty');
    next.name = name;
  }
  if (has('address')) {
    next.address = normalizeServerAddress(optional(edit.address) || '');
  }
  if (has('port')) {
    next.port = parseServerPort(edit.port);
  }
  if (has('uuid')) {
    const uuid = optional(edit.uuid);
    if (!uuid) throw new Error('UUID cannot be empty');
    next.uuid = uuid;
  }
  if (has('network')) {
    if (!NETWORKS.includes(edit.network as NetworkType)) throw new Error('Unsupported transport');
    next.network = edit.network as NetworkType;
  }
  if (has('security')) {
    if (!SECURITIES.includes(edit.security as SecurityType)) throw new Error('Unsupported security type');
    next.security = edit.security as SecurityType;
  }
  for (const key of ['headerType', 'host', 'path', 'sni', 'fingerprint', 'flow', 'encryption', 'publicKey', 'shortId', 'spiderX', 'cipher'] as const) {
    if (has(key)) next[key] = optional(edit[key]);
  }
  if (has('alpn')) {
    const list = Array.isArray(edit.alpn) ? edit.alpn : String(edit.alpn ?? '').split(',');
    const alpn = list.map((s) => s.trim()).filter(Boolean);
    next.alpn = alpn.length ? alpn : undefined;
  }
  if (has('allowInsecure')) next.allowInsecure = Boolean(edit.allowInsecure);
  if (has('alterId')) {
    const aid = Number(edit.alterId || 0);
    if (!Number.isInteger(aid) || aid < 0) throw new Error('Alter ID must be a whole number');
    next.alterId = aid;
  }

  if (next.security === 'reality' && !next.publicKey) throw new Error('Reality needs a public key');
  if (next.protocol === 'vless' && !next.encryption) next.encryption = 'none';
  if (next.protocol === 'vmess' && !next.cipher) next.cipher = 'auto';
  if (next.security === 'none') {
    next.sni = undefined;
  }
  next.path = normalizeTransportPath(next.path, next.network);
  return next;
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/** Serialises a node back to a standard vless:// or vmess:// share link. */
export function toShareLink(node: ServerNode): string {
  const transportPath = normalizeTransportPath(node.path, node.network);
  if (node.protocol === 'vmess') {
    const json: Record<string, string> = {
      v: '2',
      ps: node.name,
      add: node.address,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId ?? 0),
      scy: node.cipher || 'auto',
      net: node.network,
      type: node.headerType || 'none',
      host: node.host || '',
      path: transportPath || '',
      tls: node.security === 'tls' ? 'tls' : '',
      sni: node.sni || '',
      alpn: (node.alpn || []).join(','),
      fp: node.fingerprint || '',
    };
    if (node.allowInsecure) json.allowInsecure = '1';
    return `vmess://${Buffer.from(JSON.stringify(json), 'utf-8').toString('base64')}`;
  }

  const params = new URLSearchParams();
  params.set('encryption', node.encryption || 'none');
  params.set('type', node.network);
  params.set('security', node.security);
  if (node.sni) params.set('sni', node.sni);
  if (node.fingerprint) params.set('fp', node.fingerprint);
  if (node.alpn?.length) params.set('alpn', node.alpn.join(','));
  if (node.host) params.set('host', node.host);
  if (transportPath) params.set(node.network === 'grpc' ? 'serviceName' : 'path', transportPath);
  if (node.headerType && node.headerType !== 'none') params.set('headerType', node.headerType);
  if (node.flow) params.set('flow', node.flow);
  if (node.publicKey) params.set('pbk', node.publicKey);
  if (node.shortId) params.set('sid', node.shortId);
  if (node.spiderX) params.set('spx', node.spiderX);
  if (node.allowInsecure) params.set('allowInsecure', '1');
  return `vless://${encodeURIComponent(node.uuid)}@${formatHost(node.address)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}
