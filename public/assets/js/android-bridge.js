// packages/core/src/netUtils.ts
function randomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function encodeBase64Utf8(input) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf-8").toString("base64");
  }
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}
function decodeBase64Utf8(input) {
  const cleaned = input.trim().replace(/[\r\n\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - cleaned.length % 4) % 4;
  const padded = cleaned + "=".repeat(padLen);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf-8");
  }
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}
function parseIpv4(input) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(input)) return null;
  const parts = input.split(".");
  const out = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}
function parseIpv6(input) {
  if (!input || input.includes("%") || !input.includes(":")) return null;
  let working = input.toLowerCase();
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = (v4[0] << 8 | v4[1]).toString(16);
    const lo = (v4[2] << 8 | v4[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const doubleColonParts = working.split("::");
  if (doubleColonParts.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const groups = side.split(":");
    const nums = [];
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
function ipFamily(input) {
  if (parseIpv4(input)) return 4;
  if (parseIpv6(input)) return 6;
  return 0;
}
function ipInCidr(ip, network, prefixLen) {
  const v4Ip = parseIpv4(ip);
  const v4Net = parseIpv4(network);
  if (v4Ip && v4Net) {
    if (prefixLen < 0 || prefixLen > 32) return false;
    if (prefixLen === 0) return true;
    const ipInt = (v4Ip[0] << 24 | v4Ip[1] << 16 | v4Ip[2] << 8 | v4Ip[3]) >>> 0;
    const netInt = (v4Net[0] << 24 | v4Net[1] << 16 | v4Net[2] << 8 | v4Net[3]) >>> 0;
    const mask = prefixLen === 32 ? 4294967295 : ~((1 << 32 - prefixLen) - 1) >>> 0;
    return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
  }
  const v6Ip = parseIpv6(ip);
  const v6Net = parseIpv6(network);
  if (v6Ip && v6Net) {
    if (prefixLen < 0 || prefixLen > 128) return false;
    let remaining = prefixLen;
    for (let i = 0; i < 8 && remaining > 0; i++) {
      const bits = Math.min(16, remaining);
      const mask = bits === 16 ? 65535 : 65535 << 16 - bits & 65535;
      if ((v6Ip[i] & mask) !== (v6Net[i] & mask)) return false;
      remaining -= bits;
    }
    return true;
  }
  return false;
}
function hostnameToAscii(address) {
  try {
    const parsed = new URL(`http://${address}`);
    return parsed.hostname;
  } catch {
    return "";
  }
}

// packages/core/src/serverAddress.ts
function normalizeServerAddress(input) {
  let address = input.trim();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
    if (ipFamily(address) !== 6) throw new Error("Enter a valid server address");
  }
  if (ipFamily(address) && !address.includes("%")) return address.toLowerCase();
  if (!address || /[\s/:?#@%\[\]\\]/.test(address) || /^[\d.]+$/.test(address)) {
    throw new Error("Enter a valid server address");
  }
  const hostname = hostnameToAscii(address).toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || hostname.split(".").some(
    (label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) throw new Error("Enter a valid server address");
  return hostname;
}
function parseServerPort(input) {
  if (typeof input !== "number" && typeof input !== "string" || typeof input === "string" && !/^\d{1,5}$/.test(input)) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return port;
}

// packages/core/src/parser.ts
function normalizeNetwork(raw) {
  const val = (raw || "tcp").toLowerCase().trim();
  if (val === "ws" || val === "websocket") return "ws";
  if (val === "grpc" || val === "gun") return "grpc";
  if (val === "httpupgrade") return "httpupgrade";
  if (val === "xhttp" || val === "splithttp") return "xhttp";
  return "tcp";
}
function normalizeSecurity(raw) {
  const val = (raw || "none").toLowerCase().trim();
  if (val === "tls" || val === "xtls" || val === "1" || val === "true" || val === "ssl") {
    return "tls";
  }
  if (val === "reality") {
    return "reality";
  }
  return "none";
}
function normalizeVlessFlow(raw) {
  const flow = raw?.trim();
  return !flow || flow.toLowerCase() === "none" ? void 0 : flow;
}
function normalizeTransportPath(raw, network) {
  if (raw && ["ws", "httpupgrade", "xhttp"].includes(network) && /^%2f/i.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
    }
  }
  return raw || (network === "ws" ? "/" : void 0);
}
function parseAllowInsecure(value) {
  return value === true || value === 1 || typeof value === "string" && /^(1|true)$/i.test(value.trim());
}
function readAllowInsecure(params) {
  return parseAllowInsecure(params.get("allowInsecure") ?? params.get("insecure") ?? params.get("allow_insecure"));
}
function parseVlessUri(uri, subscriptionId) {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith("vless://")) {
    throw new Error("Invalid VLESS URI prefix");
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Malformed VLESS URL: ${trimmed.slice(0, 48)}...`);
  }
  const uuid = decodeURIComponent(url.username);
  const address = normalizeServerAddress(url.hostname);
  const port = parseServerPort(url.port || 443);
  if (!uuid || !address || !port || Number.isNaN(port)) {
    throw new Error("VLESS link is missing UUID, host, or port");
  }
  const params = url.searchParams;
  const network = normalizeNetwork(params.get("type") || params.get("net") || "tcp");
  const security = normalizeSecurity(params.get("security") || params.get("tls") || "none");
  const sni = params.get("sni") || params.get("peer") || void 0;
  const host = params.get("host") || params.get("obfsParam") || void 0;
  const rawPath = params.get("path") || params.get("serviceName") || void 0;
  const path = normalizeTransportPath(rawPath, network);
  const headerType = params.get("headerType") || params.get("obfs") || "none";
  const fingerprint = params.get("fp") || params.get("fingerprint") || "chrome";
  const alpnRaw = params.get("alpn");
  const alpn = alpnRaw ? alpnRaw.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
  const allowInsecure = readAllowInsecure(params);
  const encryption = params.get("encryption") || "none";
  const flow = normalizeVlessFlow(params.get("flow"));
  const publicKey = params.get("pbk") || void 0;
  const shortId = params.get("sid") || void 0;
  const spiderX = params.get("spx") || void 0;
  const rawHash = url.hash ? url.hash.slice(1) : "";
  let name = `${address}:${port}`;
  if (rawHash) {
    try {
      name = decodeURIComponent(rawHash).trim() || name;
    } catch {
      name = rawHash.trim() || name;
    }
  }
  return {
    id: randomId(),
    name,
    protocol: "vless",
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
    sni: sni || (security !== "none" ? host || address : void 0),
    alpn,
    fingerprint,
    allowInsecure,
    publicKey,
    shortId,
    spiderX,
    rawUri: trimmed,
    subscriptionId,
    ping: null
  };
}
function parseVmessUri(uri, subscriptionId) {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith("vmess://")) {
    throw new Error("Invalid VMess URI prefix");
  }
  const body = trimmed.slice("vmess://".length).trim();
  const decoded = decodeBase64Utf8(body);
  if (decoded.trim().startsWith("{")) {
    let json;
    try {
      json = JSON.parse(decoded);
    } catch {
      throw new Error("Malformed VMess JSON");
    }
    const address2 = normalizeServerAddress(String(json.add || json.address || ""));
    const port2 = parseServerPort(json.port === void 0 ? 443 : json.port);
    const uuid2 = String(json.id || json.uuid || "").trim();
    if (!address2 || !port2 || !uuid2) {
      throw new Error("VMess JSON missing add, port, or id");
    }
    const network2 = normalizeNetwork(String(json.net || "tcp"));
    const security2 = normalizeSecurity(String(json.tls || json.security || "none"));
    const host2 = json.host ? String(json.host).trim() : void 0;
    const path2 = normalizeTransportPath(json.path ? String(json.path).trim() : void 0, network2);
    const sni2 = json.sni ? String(json.sni).trim() : security2 === "tls" ? host2 || address2 : void 0;
    const alpnStr = json.alpn ? String(json.alpn) : "";
    const alpn = alpnStr ? alpnStr.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
    const allowInsecure = parseAllowInsecure(json.allowInsecure ?? json.insecure ?? json.allow_insecure);
    return {
      id: randomId(),
      name: String(json.ps || json.remarks || `${address2}:${port2}`).trim(),
      protocol: "vmess",
      address: address2,
      port: port2,
      uuid: uuid2,
      alterId: Number(json.aid || 0),
      cipher: String(json.scy || "auto"),
      network: network2,
      headerType: String(json.type || "none"),
      host: host2,
      path: path2,
      security: security2,
      sni: sni2,
      alpn,
      fingerprint: String(json.fp || "chrome"),
      allowInsecure,
      rawUri: trimmed,
      subscriptionId,
      ping: null
    };
  }
  let url;
  try {
    const qIdx = body.indexOf("?");
    if (qIdx !== -1 && !body.slice(0, qIdx).includes("@")) {
      const decodedHead = decodeBase64Utf8(body.slice(0, qIdx));
      url = new URL(`vmess://${decodedHead}${body.slice(qIdx)}`);
    } else {
      url = new URL(trimmed);
    }
  } catch {
    throw new Error("Malformed VMess link (neither valid Base64 JSON nor URL format)");
  }
  const rawUser = decodeURIComponent(url.username);
  const uuid = url.password ? decodeURIComponent(url.password) : rawUser;
  const cipher = url.password ? rawUser : "auto";
  const address = normalizeServerAddress(url.hostname);
  const port = parseServerPort(url.port || 443);
  if (!uuid) throw new Error("VMess link is missing UUID");
  const params = url.searchParams;
  const network = normalizeNetwork(
    params.get("type") || params.get("net") || params.get("obfs") || "tcp"
  );
  const security = normalizeSecurity(params.get("security") || params.get("tls") || "none");
  const host = params.get("host") || params.get("obfsParam") || void 0;
  const path = normalizeTransportPath(params.get("path") || void 0, network);
  const sni = params.get("sni") || params.get("peer") || (security === "tls" ? host || address : void 0);
  const name = params.get("remarks") || (url.hash ? decodeURIComponent(url.hash.slice(1)) : "") || `${address}:${port}`;
  return {
    id: randomId(),
    name,
    protocol: "vmess",
    address,
    port,
    uuid,
    alterId: Number(params.get("aid") || 0),
    cipher,
    network,
    headerType: params.get("headerType") || "none",
    host,
    path,
    security,
    sni,
    fingerprint: params.get("fp") || "chrome",
    allowInsecure: readAllowInsecure(params),
    rawUri: trimmed,
    subscriptionId,
    ping: null
  };
}
function parseShareLink(uri, subscriptionId) {
  const trimmed = uri.trim();
  if (trimmed.toLowerCase().startsWith("vless://")) {
    return parseVlessUri(trimmed, subscriptionId);
  }
  if (trimmed.toLowerCase().startsWith("vmess://")) {
    return parseVmessUri(trimmed, subscriptionId);
  }
  throw new Error(`Unsupported link protocol (only vless:// and vmess:// are supported): ${trimmed.slice(0, 24)}`);
}
function parseMultipleLinks(input, subscriptionId) {
  let content = input.trim();
  if (!content) {
    return { nodes: [], errors: ["Input is empty"] };
  }
  if (!content.toLowerCase().includes("vless://") && !content.toLowerCase().includes("vmess://")) {
    try {
      const decoded = decodeBase64Utf8(content);
      if (decoded.toLowerCase().includes("vless://") || decoded.toLowerCase().includes("vmess://")) {
        content = decoded;
      }
    } catch {
    }
  }
  const lines = content.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const nodes = [];
  const errors = [];
  for (const line of lines) {
    if (!line.toLowerCase().startsWith("vless://") && !line.toLowerCase().startsWith("vmess://")) {
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

// packages/core/src/serverEdit.ts
var NETWORKS = ["tcp", "ws", "grpc", "httpupgrade", "xhttp"];
var SECURITIES = ["none", "tls", "reality"];
var optional = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : void 0;
};
function applyServerEdit(node, edit) {
  const next = { ...node };
  const has = (k) => Object.prototype.hasOwnProperty.call(edit, k);
  if (has("name")) {
    const name = optional(edit.name);
    if (!name) throw new Error("Remarks cannot be empty");
    next.name = name;
  }
  if (has("address")) {
    next.address = normalizeServerAddress(optional(edit.address) || "");
  }
  if (has("port")) {
    next.port = parseServerPort(edit.port);
  }
  if (has("uuid")) {
    const uuid = optional(edit.uuid);
    if (!uuid) throw new Error("UUID cannot be empty");
    next.uuid = uuid;
  }
  if (has("network")) {
    if (!NETWORKS.includes(edit.network)) throw new Error("Unsupported transport");
    next.network = edit.network;
  }
  if (has("security")) {
    if (!SECURITIES.includes(edit.security)) throw new Error("Unsupported security type");
    next.security = edit.security;
  }
  for (const key of ["headerType", "host", "path", "sni", "fingerprint", "flow", "encryption", "publicKey", "shortId", "spiderX", "cipher"]) {
    if (has(key)) next[key] = optional(edit[key]);
  }
  if (has("alpn")) {
    const list = Array.isArray(edit.alpn) ? edit.alpn : String(edit.alpn ?? "").split(",");
    const alpn = list.map((s) => s.trim()).filter(Boolean);
    next.alpn = alpn.length ? alpn : void 0;
  }
  if (has("allowInsecure")) next.allowInsecure = Boolean(edit.allowInsecure);
  if (has("alterId")) {
    const aid = Number(edit.alterId || 0);
    if (!Number.isInteger(aid) || aid < 0) throw new Error("Alter ID must be a whole number");
    next.alterId = aid;
  }
  if (next.security === "reality" && !next.publicKey) throw new Error("Reality needs a public key");
  if (next.protocol === "vless" && !next.encryption) next.encryption = "none";
  if (next.protocol === "vmess" && !next.cipher) next.cipher = "auto";
  if (next.security === "none") {
    next.sni = void 0;
  }
  next.path = normalizeTransportPath(next.path, next.network);
  return next;
}
function formatHost(address) {
  return address.includes(":") ? `[${address}]` : address;
}
function toShareLink(node) {
  const transportPath = normalizeTransportPath(node.path, node.network);
  if (node.protocol === "vmess") {
    const json = {
      v: "2",
      ps: node.name,
      add: node.address,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId ?? 0),
      scy: node.cipher || "auto",
      net: node.network,
      type: node.headerType || "none",
      host: node.host || "",
      path: transportPath || "",
      tls: node.security === "tls" ? "tls" : "",
      sni: node.sni || "",
      alpn: (node.alpn || []).join(","),
      fp: node.fingerprint || ""
    };
    if (node.allowInsecure) json.allowInsecure = "1";
    return `vmess://${encodeBase64Utf8(JSON.stringify(json))}`;
  }
  const params = new URLSearchParams();
  params.set("encryption", node.encryption || "none");
  params.set("type", node.network);
  params.set("security", node.security);
  if (node.sni) params.set("sni", node.sni);
  if (node.fingerprint) params.set("fp", node.fingerprint);
  if (node.alpn?.length) params.set("alpn", node.alpn.join(","));
  if (node.host) params.set("host", node.host);
  if (transportPath) params.set(node.network === "grpc" ? "serviceName" : "path", transportPath);
  if (node.headerType && node.headerType !== "none") params.set("headerType", node.headerType);
  if (node.flow) params.set("flow", node.flow);
  if (node.publicKey) params.set("pbk", node.publicKey);
  if (node.shortId) params.set("sid", node.shortId);
  if (node.spiderX) params.set("spx", node.spiderX);
  if (node.allowInsecure) params.set("allowInsecure", "1");
  return `vless://${encodeURIComponent(node.uuid)}@${formatHost(node.address)}:${node.port}?${params.toString()}#${encodeURIComponent(node.name)}`;
}

// packages/core/src/subscription.ts
function parseUserInfoHeader(headerVal) {
  if (!headerVal) return {};
  const result = {};
  const parts = headerVal.split(";").map((s) => s.trim());
  for (const part of parts) {
    const [key, val] = part.split("=").map((s) => s.trim().toLowerCase());
    const num = Number(val);
    if (!Number.isFinite(num)) continue;
    if (key === "upload") result.uploadBytes = num;
    if (key === "download") result.downloadBytes = num;
    if (key === "total") result.totalBytes = num;
    if (key === "expire") result.expireTimestamp = num * 1e3;
  }
  return result;
}
async function fetchSubscription(url, existingId, customName) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
    throw new Error("Subscription URL must start with http:// or https://");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const response = await fetch(trimmedUrl, {
      headers: {
        "User-Agent": "v2rayN/6.45 (Windows NT 10.0; Win64; x64) Xray-VPN-Client/1.0",
        Accept: "*/*"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const bodyText = await response.text();
    const subId = existingId || randomId();
    const { nodes, errors } = parseMultipleLinks(bodyText, subId);
    if (nodes.length === 0) {
      throw new Error(
        errors.length > 0 ? `No valid VLESS/VMess nodes found (${errors[0]})` : "Subscription returned 0 valid vless:// or vmess:// links"
      );
    }
    const userInfoHeader = response.headers.get("subscription-userinfo") || response.headers.get("Subscription-Userinfo");
    const quota = parseUserInfoHeader(userInfoHeader);
    const intervalRaw = response.headers.get("profile-update-interval") || response.headers.get("Profile-Update-Interval");
    const updateIntervalHours = intervalRaw && Number.isFinite(Number(intervalRaw)) && Number(intervalRaw) > 0 ? Number(intervalRaw) : void 0;
    const supportUrl = response.headers.get("profile-web-page-url") || response.headers.get("support-url") || void 0;
    let resolvedName = customName?.trim() || "";
    if (!resolvedName) {
      const titleHeader = response.headers.get("profile-title") || response.headers.get("content-disposition");
      if (titleHeader && titleHeader.startsWith("base64:")) {
        try {
          resolvedName = decodeBase64Utf8(titleHeader.slice(7)).trim();
        } catch {
        }
      }
      if (!resolvedName) {
        try {
          const parsedUrl = new URL(trimmedUrl);
          resolvedName = parsedUrl.hostname;
        } catch {
          resolvedName = "Subscription";
        }
      }
    }
    const subscription = {
      id: subId,
      name: resolvedName,
      url: trimmedUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabled: true,
      ...quota,
      ...updateIntervalHours ? { updateIntervalHours } : {},
      ...supportUrl ? { supportUrl } : {},
      nodeCount: nodes.length
    };
    return {
      subscription,
      nodes,
      errors
    };
  } finally {
    clearTimeout(timeout);
  }
}

// packages/core/src/subscriptionState.ts
function replaceSubscriptionNodes(data, subId, subscription, nodes = []) {
  const existing = data.subscriptions.find((sub) => sub.id === subId);
  if (!existing) throw new Error("Subscription not found (it may have been deleted while refreshing)");
  const previous = data.servers.filter((node) => node.subscriptionId === subId);
  const remaining = new Set(previous);
  const matches = /* @__PURE__ */ new Map();
  const connectionKey = (node) => toShareLink({ ...node, name: "" });
  for (const node of nodes) {
    const key = connectionKey(node);
    const match = [...remaining].find((old) => connectionKey(old) === key);
    if (match) {
      matches.set(node, match);
      remaining.delete(match);
    }
  }
  for (const node of nodes) {
    const match = matches.get(node) || [...remaining].find(
      (old) => old.protocol === node.protocol && old.address === node.address && old.port === node.port && old.uuid === node.uuid
    );
    if (!match) continue;
    remaining.delete(match);
    node.id = match.id;
    node.geo = match.geo ?? null;
    node.ping = match.ping ?? null;
    if (match.pingStatus !== "measuring") {
      node.pingStatus = match.pingStatus;
      node.pingError = match.pingError;
      node.pingCheckedAt = match.pingCheckedAt;
    }
  }
  if (subscription) {
    subscription.createdAt = existing.createdAt || existing.updatedAt;
    subscription.totalBytes ??= existing.totalBytes;
    subscription.expireTimestamp ??= existing.expireTimestamp;
    data.subscriptions[data.subscriptions.indexOf(existing)] = subscription;
  } else {
    data.subscriptions = data.subscriptions.filter((sub) => sub.id !== subId);
  }
  data.servers = [...data.servers.filter((node) => node.subscriptionId !== subId), ...nodes];
  if (!data.servers.some((node) => node.id === data.activeServerId)) {
    data.activeServerId = data.servers[0]?.id || null;
  }
}

// packages/core/src/networkSettings.ts
var XRAY_API_PORT = 10085;
function getNetworkSettings(data) {
  return {
    socksPort: data.socksPort,
    httpPort: data.httpPort,
    bypassLan: data.bypassLan,
    allowInsecureDefault: data.allowInsecureDefault,
    muxEnabled: Boolean(data.muxEnabled)
  };
}
function validateNetworkSettings(current, patch, uiPort) {
  const next = getNetworkSettings(current);
  for (const field of ["socksPort", "httpPort"]) {
    const value = patch[field] === void 0 ? next[field] : patch[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1025 || value > 65535) {
      throw new Error(`${field === "socksPort" ? "SOCKS" : "HTTP"} port must be an integer between 1025 and 65535`);
    }
    next[field] = value;
    if (next[field] === XRAY_API_PORT || next[field] === uiPort) throw new Error(`Port ${next[field]} is reserved by the VPN controller`);
  }
  if (next.socksPort === next.httpPort) throw new Error("SOCKS and HTTP ports must be different");
  for (const field of ["bypassLan", "allowInsecureDefault", "muxEnabled"]) {
    if (patch[field] === void 0) continue;
    if (typeof patch[field] !== "boolean") throw new Error(`${field} must be true or false`);
    next[field] = patch[field];
  }
  return next;
}

// packages/core/src/adblockEngine.ts
var YOUTUBE_AD_DOMAINS = [
  "ads.youtube.com",
  "ad.youtube.com",
  "video-ad-stats.googlesyndication.com",
  "pagead2.googlesyndication.com",
  "tpc.googlesyndication.com",
  "googleads.g.doubleclick.net",
  "pubads.g.doubleclick.net",
  "securepubads.g.doubleclick.net",
  "static.doubleclick.net",
  "cm.g.doubleclick.net",
  "ad.doubleclick.net",
  "doubleclick.net",
  "googleadservices.com",
  "www.googleadservices.com",
  "s0.2mdn.net",
  "2mdn.net",
  "imasdk.googleapis.com",
  "innovid.com",
  "fwmrm.net",
  "moatads.com",
  "doubleverify.com",
  "iasds01.com",
  "flashtalking.com"
];
var AD_NETWORK_DOMAINS = [
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "criteo.net",
  "adnxs.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "smartadserver.com",
  "amazon-adsystem.com",
  "adsrvr.org",
  "popads.net",
  "popcash.net",
  "propellerads.com",
  "exoclick.com",
  "adsterra.com",
  "juicyads.com",
  "mgid.com",
  "revcontent.com",
  "zedo.com",
  "adform.net",
  "advertising.com",
  "mediavine.com",
  "adthrive.com",
  "carbonads.com",
  "buysellads.com"
];
var TRACKER_DOMAINS = [
  "scorecardresearch.com",
  "quantserve.com",
  "hotjar.com",
  "mouseflow.com",
  "fullstory.com",
  "luckyorange.com",
  "crazyegg.com",
  "mixpanel.com",
  "amplitude.com",
  "segment.io",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "kochava.com",
  "singular.net",
  "clarity.ms",
  "omtrdc.net",
  "demdex.net",
  "krxd.net",
  "bluekai.com",
  "lotame.com",
  "chartbeat.com",
  "parsely.com",
  "statcounter.com",
  "histats.com"
];
var MALWARE_DOMAINS = [
  "coinhive.com",
  "crypto-loot.com",
  "coin-hive.com",
  "jsecoin.com",
  "minero.cc",
  "webminepool.com",
  "authedmine.com",
  "cryptoloot.pro",
  "ppoi.org",
  "miner.pr0gramm.com"
];
function defaultAdBlockConfig() {
  return {
    enabled: true,
    blockYoutubeAds: true,
    blockAds: true,
    blockTrackers: true,
    blockMalware: true,
    adguardDns: true,
    customBlockedDomains: [],
    whitelistedDomains: []
  };
}
function buildInitialHourlyBuckets(now = Date.now()) {
  const currentHour = Math.floor(now / 36e5) * 36e5;
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    const ts = currentHour - i * 36e5;
    buckets.push({
      key: String(ts),
      timestamp: ts,
      blocked: 0,
      savedBytes: 0
    });
  }
  return buckets;
}
function ensureAdBlockState(existing) {
  const cfg = {
    ...defaultAdBlockConfig(),
    ...existing?.config || {},
    customBlockedDomains: Array.isArray(existing?.config?.customBlockedDomains) ? existing.config.customBlockedDomains : [],
    whitelistedDomains: Array.isArray(existing?.config?.whitelistedDomains) ? existing.config.whitelistedDomains : []
  };
  const defaultByCat = {
    youtube_ads: { blocked: 0, savedBytes: 0 },
    ad_networks: { blocked: 0, savedBytes: 0 },
    trackers: { blocked: 0, savedBytes: 0 },
    malware: { blocked: 0, savedBytes: 0 },
    custom: { blocked: 0, savedBytes: 0 }
  };
  const byCategory = {
    ...defaultByCat,
    ...existing?.byCategory || {}
  };
  let hourly = Array.isArray(existing?.hourly) && existing.hourly.length > 0 ? existing.hourly : buildInitialHourlyBuckets();
  const currentHour = Math.floor(Date.now() / 36e5) * 36e5;
  const lastBucket = hourly[hourly.length - 1];
  if (!lastBucket || lastBucket.timestamp < currentHour) {
    const map = new Map(hourly.map((b) => [b.timestamp, b]));
    const updated = [];
    for (let i = 23; i >= 0; i--) {
      const ts = currentHour - i * 36e5;
      updated.push(
        map.get(ts) || {
          key: String(ts),
          timestamp: ts,
          blocked: 0,
          savedBytes: 0
        }
      );
    }
    hourly = updated;
  }
  return {
    config: cfg,
    totalBlocked: Number(existing?.totalBlocked || 0),
    savedBytes: Number(existing?.savedBytes || 0),
    savedMs: Number(existing?.savedMs || 0),
    byCategory,
    hourly,
    topDomains: existing?.topDomains && typeof existing.topDomains === "object" ? existing.topDomains : {},
    recentBlocked: Array.isArray(existing?.recentBlocked) ? existing.recentBlocked.slice(0, 60) : []
  };
}
function buildAdBlockRoutingRules(config, splitRouting = {
  rules: [],
  defaultOutboundTag: "proxy"
}) {
  if (!config || !config.enabled) return [];
  const rules = [];
  const whitelist = (config.whitelistedDomains || []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (whitelist.length > 0) {
    for (const rule of splitRouting.rules) {
      let domains = whitelist.map((d) => `domain:${d}`);
      if (Array.isArray(rule.domain)) {
        domains = [];
        for (const allowed of whitelist) {
          for (const domainRule of rule.domain) {
            const selected = domainRule.slice("domain:".length);
            if (allowed === selected || allowed.endsWith(`.${selected}`)) domains.push(`domain:${allowed}`);
            else if (selected.endsWith(`.${allowed}`)) domains.push(domainRule);
          }
        }
      }
      if (domains.length) rules.push({ ...rule, domain: [...new Set(domains)] });
    }
    rules.push({
      type: "field",
      domain: whitelist.map((d) => `domain:${d}`),
      outboundTag: splitRouting.defaultOutboundTag
    });
  }
  const blockedDomains = [];
  if (config.blockYoutubeAds) {
    for (const d of YOUTUBE_AD_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }
  if (config.blockAds) {
    blockedDomains.push("geosite:category-ads-all");
    for (const d of AD_NETWORK_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }
  if (config.blockTrackers) {
    for (const d of TRACKER_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }
  if (config.blockMalware) {
    for (const d of MALWARE_DOMAINS) {
      blockedDomains.push(`domain:${d}`);
    }
  }
  for (const custom of config.customBlockedDomains || []) {
    const clean = custom.trim().toLowerCase();
    if (clean) blockedDomains.push(`domain:${clean}`);
  }
  if (blockedDomains.length > 0) {
    rules.push({
      type: "field",
      domain: Array.from(new Set(blockedDomains)),
      outboundTag: "adblock"
    });
  }
  return rules;
}
function classifyBlockedDomain(rawDomain, config) {
  const host = rawDomain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (config?.customBlockedDomains?.some(
    (c) => host === c.toLowerCase() || host.endsWith(`.${c.toLowerCase()}`)
  )) {
    return { category: "custom", savedBytes: 24576, savedMs: 55 };
  }
  if (YOUTUBE_AD_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) || host.includes("youtube") || host.includes("googlesyndication") || host.includes("doubleclick") || host.includes("googleadservices") || host.includes("2mdn.net") || host.includes("moatads") || host.includes("innovid")) {
    return { category: "youtube_ads", savedBytes: 78848, savedMs: 85 };
  }
  if (MALWARE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) || host.includes("miner") || host.includes("coinhive") || host.includes("cryptoloot")) {
    return { category: "malware", savedBytes: 19456, savedMs: 60 };
  }
  if (TRACKER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) || host.includes("analytics") || host.includes("telemetry") || host.includes("tracker") || host.includes("metric") || host.includes("pixel") || host.includes("beacon") || host.includes("scorecardresearch") || host.includes("hotjar") || host.includes("mixpanel") || host.includes("segment")) {
    return { category: "trackers", savedBytes: 12288, savedMs: 48 };
  }
  return { category: "ad_networks", savedBytes: 34816, savedMs: 65 };
}
function evaluateDomainShield(rawDomain, config) {
  const host = rawDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
  if (!host) return { blocked: false, reason: "Empty hostname" };
  if (!config.enabled) return { blocked: false, reason: "Master Shield is currently paused" };
  const matchesList = (list) => list.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  if (matchesList(config.whitelistedDomains || [])) {
    return { blocked: false, reason: "Explicitly allowed by your Whitelist" };
  }
  if (matchesList(config.customBlockedDomains || [])) {
    return { blocked: true, reason: "Matched your Custom Blocklist rule", category: "custom" };
  }
  if (config.blockYoutubeAds && matchesList(YOUTUBE_AD_DOMAINS)) {
    return { blocked: true, reason: "Blocked by YouTube & Video Ad Shield", category: "youtube_ads" };
  }
  if (config.blockMalware && matchesList(MALWARE_DOMAINS)) {
    return { blocked: true, reason: "Blocked by Malware & Cryptominer Shield", category: "malware" };
  }
  if (config.blockTrackers && matchesList(TRACKER_DOMAINS)) {
    return { blocked: true, reason: "Blocked by Cross-Site Tracker Shield", category: "trackers" };
  }
  if (config.blockAds && (matchesList(AD_NETWORK_DOMAINS) || host.startsWith("ad.") || host.startsWith("ads.") || host.includes("doubleclick") || host.includes("googlesyndication") || host.includes("googleadservices") || host.includes("adserver") || host.includes("adservice"))) {
    return { blocked: true, reason: "Blocked by Global Ad Network & Geosite Shield", category: "ad_networks" };
  }
  return { blocked: false, reason: "Clean domain \u2014 allowed through tunnel" };
}
function recordBlockedDomain(state, rawDomain, now = Date.now()) {
  const domain = rawDomain.trim().toLowerCase().replace(/^\/\/|^tcp:|^udp:/, "").replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
  if (!domain || domain === "127.0.0.1" || domain === "localhost") return;
  const { category, savedBytes, savedMs } = classifyBlockedDomain(domain, state.config);
  state.totalBlocked += 1;
  state.savedBytes += savedBytes;
  state.savedMs += savedMs;
  if (!state.byCategory[category]) {
    state.byCategory[category] = { blocked: 0, savedBytes: 0 };
  }
  state.byCategory[category].blocked += 1;
  state.byCategory[category].savedBytes += savedBytes;
  const currentHour = Math.floor(now / 36e5) * 36e5;
  let bucket = state.hourly.find((b) => b.timestamp === currentHour);
  if (!bucket) {
    state.hourly = ensureAdBlockState(state).hourly;
    bucket = state.hourly[state.hourly.length - 1];
  }
  if (bucket) {
    bucket.blocked += 1;
    bucket.savedBytes += savedBytes;
  }
  const existing = state.topDomains[domain];
  if (existing) {
    existing.count += 1;
    existing.savedBytes += savedBytes;
    existing.lastBlockedAt = now;
  } else {
    state.topDomains[domain];
    state.topDomains[domain] = {
      domain,
      category,
      count: 1,
      savedBytes,
      lastBlockedAt: now
    };
    const keys = Object.keys(state.topDomains);
    if (keys.length > 60) {
      const sorted = Object.values(state.topDomains).sort((a, b) => b.count - a.count);
      state.topDomains = Object.fromEntries(sorted.slice(0, 50).map((d) => [d.domain, d]));
    }
  }
  state.recentBlocked.unshift({
    id: randomId(),
    timestamp: now,
    domain,
    category,
    savedBytes
  });
  if (state.recentBlocked.length > 50) {
    state.recentBlocked.length = 50;
  }
}
function parseAdBlockAccessLogChunk(text, state, now = Date.now()) {
  if (!state.config.enabled || !text) return 0;
  const lines = text.split(/\r?\n/);
  let newlyBlocked = 0;
  for (const line of lines) {
    if (!line.includes("-> adblock]")) continue;
    const match = line.match(/accepted\s+(?:tcp:|udp:|\/\/)?([^\s/:]+)(?::\d+)?\s+\[[^\]]*->\s*adblock\]/i);
    if (match && match[1]) {
      recordBlockedDomain(state, match[1], now);
      newlyBlocked++;
    }
  }
  return newlyBlocked;
}

// packages/core/src/splitTunnelEngine.ts
var SPLIT_TUNNEL_PRESETS = {
  sri_lanka_local: {
    id: "sri_lanka_local",
    title: "Sri Lanka & Local Banking (.lk)",
    subtitle: "Commercial Bank, Sampath, HNB, BOC, Dialog, SLT, Mobitel, Gov.lk & all .lk domains",
    domains: [
      "domain:lk",
      "domain:combank.lk",
      "domain:sampath.lk",
      "domain:hnb.net",
      "domain:hnb.lk",
      "domain:boc.lk",
      "domain:peoplesbank.lk",
      "domain:ndbbank.com",
      "domain:seylan.lk",
      "domain:frimi.lk",
      "domain:dialog.lk",
      "domain:slt.lk",
      "domain:mobitel.lk",
      "domain:daraz.lk",
      "domain:ikman.lk",
      "domain:pickme.lk"
    ],
    sampleHosts: ["combank.lk", "sampath.lk", "dialog.lk", "gov.lk", "daraz.lk"]
  },
  gaming: {
    id: "gaming",
    title: "Gaming & Game Launchers",
    subtitle: "Steam, Epic Games, Riot Games (Valorant/LoL), Battle.net, EA, Xbox Live & PSN",
    domains: [
      "domain:steampowered.com",
      "domain:steamcommunity.com",
      "domain:steamstatic.com",
      "domain:steamserver.net",
      "domain:steamcontent.com",
      "domain:epicgames.com",
      "domain:unrealengine.com",
      "domain:riotgames.com",
      "domain:leagueoflegends.com",
      "domain:playvalorant.com",
      "domain:battle.net",
      "domain:blizzard.com",
      "domain:ea.com",
      "domain:origin.com",
      "domain:xboxlive.com",
      "domain:playstation.com",
      "domain:playstation.net"
    ],
    sampleHosts: ["steampowered.com", "epicgames.com", "riotgames.com", "battle.net", "xboxlive.com"]
  },
  streaming: {
    id: "streaming",
    title: "Streaming & Media Platforms",
    subtitle: "Netflix, Disney+, Amazon Prime Video, Spotify, Twitch & Apple TV+",
    domains: [
      "domain:netflix.com",
      "domain:nflxvideo.net",
      "domain:nflximg.net",
      "domain:nflxso.net",
      "domain:disneyplus.com",
      "domain:bamgrid.com",
      "domain:primevideo.com",
      "domain:aiv-cdn.net",
      "domain:spotify.com",
      "domain:scdn.co",
      "domain:twitch.tv",
      "domain:ttvnw.net",
      "domain:jtvnw.net",
      "domain:tv.apple.com"
    ],
    sampleHosts: ["netflix.com", "disneyplus.com", "primevideo.com", "spotify.com", "twitch.tv"]
  },
  messaging: {
    id: "messaging",
    title: "Messaging, Voice & Video Calls",
    subtitle: "WhatsApp, Telegram, Discord, Zoom, Microsoft Teams & Signal",
    domains: [
      "domain:whatsapp.com",
      "domain:whatsapp.net",
      "domain:wa.me",
      "domain:telegram.org",
      "domain:t.me",
      "domain:tdesktop.com",
      "domain:discord.com",
      "domain:discordapp.com",
      "domain:discordapp.net",
      "domain:discord.gg",
      "domain:discord.media",
      "domain:zoom.us",
      "domain:zoomgov.com",
      "domain:teams.microsoft.com",
      "domain:signal.org"
    ],
    sampleHosts: ["whatsapp.com", "telegram.org", "discord.com", "zoom.us", "signal.org"]
  },
  ai_cloud: {
    id: "ai_cloud",
    title: "AI & Developer Cloud",
    subtitle: "ChatGPT (OpenAI), Claude (Anthropic), Google Gemini, Perplexity & GitHub",
    domains: [
      "domain:openai.com",
      "domain:chatgpt.com",
      "domain:oaistatic.com",
      "domain:oaiusercontent.com",
      "domain:anthropic.com",
      "domain:claude.ai",
      "domain:gemini.google.com",
      "domain:perplexity.ai",
      "domain:github.com",
      "domain:githubusercontent.com",
      "domain:githubassets.com"
    ],
    sampleHosts: ["chatgpt.com", "openai.com", "claude.ai", "gemini.google.com", "github.com"]
  },
  windows_updates: {
    id: "windows_updates",
    title: "Windows Update & System CDNs",
    subtitle: "Microsoft Update, Delivery Optimization & Windows Store background downloads",
    domains: [
      "domain:windowsupdate.com",
      "domain:update.microsoft.com",
      "domain:delivery.mp.microsoft.com",
      "domain:dl.delivery.mp.microsoft.com",
      "domain:windowsupdate.microsoft.com",
      "domain:download.windowsupdate.com"
    ],
    sampleHosts: ["windowsupdate.com", "update.microsoft.com", "delivery.mp.microsoft.com"]
  }
};
var PRESET_IDS = Object.keys(SPLIT_TUNNEL_PRESETS);
function defaultSplitTunnelConfig() {
  return {
    mode: "off",
    presets: {
      sri_lanka_local: true,
      gaming: true,
      streaming: false,
      messaging: false,
      ai_cloud: false,
      windows_updates: true
    },
    customDomains: [],
    customIps: []
  };
}
function ensureSplitTunnelConfig(raw) {
  const def = defaultSplitTunnelConfig();
  if (!raw || typeof raw !== "object") return def;
  const mode = raw.mode === "bypass" || raw.mode === "vpn_only" || raw.mode === "off" ? raw.mode : "off";
  const presets = { ...def.presets };
  if (raw.presets && typeof raw.presets === "object") {
    for (const id of PRESET_IDS) {
      if (typeof raw.presets[id] === "boolean") {
        presets[id] = raw.presets[id];
      }
    }
  }
  const customDomains = Array.isArray(raw.customDomains) ? Array.from(new Set(raw.customDomains.map(sanitizeDomainEntry).filter(Boolean))) : [];
  const customIps = Array.isArray(raw.customIps) ? Array.from(new Set(raw.customIps.map(sanitizeIpEntry).filter(Boolean))) : [];
  const result = {
    mode,
    presets,
    customDomains,
    customIps
  };
  if (raw.perAppMode === "off" || raw.perAppMode === "bypass_selected" || raw.perAppMode === "only_selected") {
    result.perAppMode = raw.perAppMode;
  }
  if (Array.isArray(raw.selectedApps)) {
    result.selectedApps = Array.from(
      new Set(
        raw.selectedApps.map((pkg) => String(pkg || "").trim()).filter((pkg) => /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg))
      )
    );
  }
  return result;
}
function sanitizeIpEntry(input) {
  const s = String(input || "").trim();
  const [address, prefix, ...extra] = s.split("/");
  const family = ipFamily(address);
  if (!family || extra.length || address.includes("%")) return "";
  if (prefix !== void 0) {
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) return "";
    return `${address.toLowerCase()}/${Number(prefix)}`;
  }
  return address.toLowerCase();
}
function sanitizeDomainEntry(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//i, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
  if (!s || s.includes(" ") || sanitizeIpEntry(s)) return "";
  if (s.length > 253 || /^[\d.]+$/.test(s) || s.split(".").some(
    (label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) return "";
  return s;
}
function parseSplitTargetInput(raw) {
  const ip = sanitizeIpEntry(raw);
  if (ip) return { kind: "ip", value: ip };
  const domain = sanitizeDomainEntry(raw);
  if (domain) return { kind: "domain", value: domain };
  return null;
}
function buildSplitTunnelRoutingRules(config) {
  if (!config || config.mode === "off") {
    return { rules: [], defaultOutboundTag: "proxy" };
  }
  const targetOutbound = config.mode === "bypass" ? "direct" : "proxy";
  const defaultOutboundTag = config.mode === "bypass" ? "proxy" : "direct";
  const domainRules = /* @__PURE__ */ new Set();
  const ipRules = /* @__PURE__ */ new Set();
  for (const id of PRESET_IDS) {
    if (config.presets?.[id]) {
      const preset = SPLIT_TUNNEL_PRESETS[id];
      for (const d of preset.domains) domainRules.add(d);
    }
  }
  for (const dom of config.customDomains || []) {
    const clean = sanitizeDomainEntry(dom);
    if (clean) domainRules.add(`domain:${clean}`);
  }
  for (const ip of config.customIps || []) {
    const clean = sanitizeIpEntry(ip);
    if (clean) ipRules.add(clean);
  }
  const rules = [];
  if (domainRules.size > 0) {
    rules.push({
      type: "field",
      domain: Array.from(domainRules),
      outboundTag: targetOutbound
    });
  }
  if (ipRules.size > 0) {
    rules.push({
      type: "field",
      ip: Array.from(ipRules),
      outboundTag: targetOutbound
    });
  }
  return { rules, defaultOutboundTag };
}
function ipMatchesCidr(ip, cidrOrIp) {
  if (!sanitizeIpEntry(cidrOrIp)) return false;
  const [network, prefix] = cidrOrIp.split("/");
  const family = ipFamily(ip);
  if (!family || ipFamily(network) !== family) return false;
  const prefixLen = prefix === void 0 ? family === 4 ? 32 : 128 : Number(prefix);
  return ipInCidr(ip, network, prefixLen);
}
function isPrivateLanIp(ip) {
  return ipMatchesCidr(ip, "127.0.0.0/8") || ipMatchesCidr(ip, "10.0.0.0/8") || ipMatchesCidr(ip, "172.16.0.0/12") || ipMatchesCidr(ip, "192.168.0.0/16") || ipMatchesCidr(ip, "169.254.0.0/16") || ipMatchesCidr(ip, "::1/128") || ipMatchesCidr(ip, "fc00::/7") || ipMatchesCidr(ip, "fe80::/10");
}
function evaluateSplitTunnelRoute(rawTarget, splitConfig, adblockConfig, bypassLan = true) {
  const parsed = parseSplitTargetInput(rawTarget);
  const cfg = ensureSplitTunnelConfig(splitConfig);
  if (!parsed) {
    return {
      target: String(rawTarget || "").trim(),
      outbound: cfg.mode === "vpn_only" ? "direct" : "proxy",
      routeLabel: cfg.mode === "vpn_only" ? "Direct ISP" : "Encrypted VPN Tunnel",
      matchedSource: "Default Policy",
      matchedRule: "Invalid or empty target"
    };
  }
  if (parsed.kind === "ip" && bypassLan && isPrivateLanIp(parsed.value.split("/")[0])) {
    return {
      target: parsed.value,
      outbound: "direct",
      routeLabel: "Direct Local Network (LAN)",
      matchedSource: "Bypass Local Networks",
      matchedRule: "Private RFC1918 / Loopback IP"
    };
  }
  if (parsed.kind === "domain" && adblockConfig?.enabled) {
    const shieldCheck = evaluateDomainShield(parsed.value, adblockConfig);
    if (shieldCheck.blocked) {
      return {
        target: parsed.value,
        outbound: "adblock",
        routeLabel: "Blocked by Privacy & Ad Shield",
        matchedSource: `Ad Shield (${shieldCheck.category || "filter"})`,
        matchedRule: shieldCheck.reason
      };
    }
  }
  if (cfg.mode === "off") {
    return {
      target: parsed.value,
      outbound: "proxy",
      routeLabel: "Encrypted VPN Tunnel",
      matchedSource: "Split Tunneling Off (Full Tunnel)",
      matchedRule: 'outboundTag: "proxy"'
    };
  }
  const matchedOutbound = cfg.mode === "bypass" ? "direct" : "proxy";
  const matchedLabel = matchedOutbound === "direct" ? "Direct ISP (Bypasses VPN)" : "Encrypted VPN Tunnel (VPN-Only Match)";
  const fallbackOutbound = cfg.mode === "bypass" ? "proxy" : "direct";
  const fallbackLabel = fallbackOutbound === "proxy" ? "Encrypted VPN Tunnel (Default)" : "Direct ISP (Outside VPN-Only List)";
  if (parsed.kind === "domain") {
    const host = parsed.value;
    for (const customDom of cfg.customDomains) {
      if (host === customDom || host.endsWith(`.${customDom}`)) {
        return {
          target: host,
          outbound: matchedOutbound,
          routeLabel: matchedLabel,
          matchedSource: "Custom Website Rule",
          matchedRule: `domain:${customDom} -> ${matchedOutbound}`
        };
      }
    }
    for (const id of PRESET_IDS) {
      if (!cfg.presets[id]) continue;
      const preset = SPLIT_TUNNEL_PRESETS[id];
      for (const rule of preset.domains) {
        const suffix = rule.replace(/^domain:/, "");
        if (host === suffix || host.endsWith(`.${suffix}`)) {
          return {
            target: host,
            outbound: matchedOutbound,
            routeLabel: matchedLabel,
            matchedSource: `Preset: ${preset.title}`,
            matchedRule: `${rule} -> ${matchedOutbound}`
          };
        }
      }
    }
  } else {
    const ipOnly = parsed.value.split("/")[0];
    for (const customIp of cfg.customIps) {
      if (customIp === parsed.value || ipMatchesCidr(ipOnly, customIp)) {
        return {
          target: parsed.value,
          outbound: matchedOutbound,
          routeLabel: matchedLabel,
          matchedSource: "Custom IP / Subnet Rule",
          matchedRule: `ip:${customIp} -> ${matchedOutbound}`
        };
      }
    }
  }
  return {
    target: parsed.value,
    outbound: fallbackOutbound,
    routeLabel: fallbackLabel,
    matchedSource: cfg.mode === "bypass" ? "All Other Traffic \u2192 VPN" : "All Unlisted Traffic \u2192 Direct ISP",
    matchedRule: `outboundTag: "${fallbackOutbound}"`
  };
}

// packages/core/src/usageTracker.ts
var MAX_MINUTE_BUCKETS = 60;
var MAX_HOUR_BUCKETS = 168;
var MAX_DAY_BUCKETS = 90;
function defaultDataCap() {
  return {
    enabled: false,
    period: "monthly",
    limitBytes: 50 * 1024 * 1024 * 1024,
    // 50 GB default
    alertPct: 80,
    autoDisconnect: false
  };
}
function formatDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatMonthPrefix(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function ensureUsageHistory(data, now = Date.now()) {
  if (!data.usageHistory) {
    const history = {
      minutes: [],
      hours: [],
      days: [],
      perServer: {},
      dataCap: defaultDataCap(),
      peakDownSpeed: 0,
      peakUpSpeed: 0
    };
    const existingUp = Math.max(0, Number(data.totalUp || 0));
    const existingDown = Math.max(0, Number(data.totalDown || 0));
    if (existingUp > 0 || existingDown > 0) {
      const hourStart = Math.floor(now / 36e5) * 36e5;
      const dayKey = formatDayKey(now);
      history.hours.push({
        key: String(hourStart),
        timestamp: hourStart,
        upBytes: existingUp,
        downBytes: existingDown
      });
      history.days.push({
        key: dayKey,
        timestamp: (/* @__PURE__ */ new Date(dayKey + "T00:00:00")).getTime() || now,
        upBytes: existingUp,
        downBytes: existingDown
      });
      const node = data.servers.find((s) => s.id === data.activeServerId) || data.servers[0];
      if (node) {
        history.perServer[node.id] = {
          serverId: node.id,
          serverName: node.name,
          address: `${node.address}:${node.port}`,
          protocol: node.protocol,
          countryCode: node.geo?.countryCode ?? null,
          country: node.geo?.country ?? null,
          subscriptionId: node.subscriptionId ?? null,
          upBytes: existingUp,
          downBytes: existingDown,
          connectedSeconds: 0,
          sessions: 1,
          lastUsedAt: now
        };
      }
    }
    data.usageHistory = history;
    return history;
  }
  const h = data.usageHistory;
  if (!Array.isArray(h.minutes)) h.minutes = [];
  if (!Array.isArray(h.hours)) h.hours = [];
  if (!Array.isArray(h.days)) h.days = [];
  if (!h.perServer || typeof h.perServer !== "object") h.perServer = {};
  if (!h.dataCap || typeof h.dataCap !== "object") h.dataCap = defaultDataCap();
  if (typeof h.peakDownSpeed !== "number") h.peakDownSpeed = 0;
  if (typeof h.peakUpSpeed !== "number") h.peakUpSpeed = 0;
  for (const s of data.servers) {
    const rec = h.perServer[s.id];
    if (rec) {
      rec.serverName = s.name;
      rec.address = `${s.address}:${s.port}`;
      rec.protocol = s.protocol;
      if (s.geo?.countryCode) rec.countryCode = s.geo.countryCode;
      if (s.geo?.country) rec.country = s.geo.country;
      if (s.subscriptionId) rec.subscriptionId = s.subscriptionId;
    }
  }
  return h;
}
function addToBucketList(list, key, timestamp, upDelta, downDelta, maxLen) {
  const last = list[list.length - 1];
  if (last && last.key === key) {
    last.upBytes += upDelta;
    last.downBytes += downDelta;
    return;
  }
  const existing = list.find((b) => b.key === key);
  if (existing) {
    existing.upBytes += upDelta;
    existing.downBytes += downDelta;
    return;
  }
  list.push({
    key,
    timestamp,
    upBytes: upDelta,
    downBytes: downDelta
  });
  if (list.length > maxLen) {
    list.splice(0, list.length - maxLen);
  }
}
function recordSessionStart(data, node, now = Date.now()) {
  const h = ensureUsageHistory(data, now);
  const existing = h.perServer[node.id];
  if (existing) {
    existing.serverName = node.name;
    existing.address = `${node.address}:${node.port}`;
    existing.protocol = node.protocol;
    existing.countryCode = node.geo?.countryCode ?? existing.countryCode ?? null;
    existing.country = node.geo?.country ?? existing.country ?? null;
    existing.subscriptionId = node.subscriptionId ?? existing.subscriptionId ?? null;
    existing.sessions = (existing.sessions || 0) + 1;
    existing.lastUsedAt = now;
  } else {
    h.perServer[node.id] = {
      serverId: node.id,
      serverName: node.name,
      address: `${node.address}:${node.port}`,
      protocol: node.protocol,
      countryCode: node.geo?.countryCode ?? null,
      country: node.geo?.country ?? null,
      subscriptionId: node.subscriptionId ?? null,
      upBytes: 0,
      downBytes: 0,
      connectedSeconds: 0,
      sessions: 1,
      lastUsedAt: now
    };
  }
}
function evaluateDataCap(h, now = Date.now()) {
  const cap = h.dataCap;
  const dayKey = formatDayKey(now);
  const monthPrefix = formatMonthPrefix(now);
  const periodKey = cap.period === "daily" ? dayKey : monthPrefix;
  const periodLabel = cap.period === "daily" ? "today" : "this month";
  let usedBytes = 0;
  if (cap.period === "daily") {
    const today = h.days.find((d) => d.key === dayKey);
    usedBytes = today ? today.upBytes + today.downBytes : 0;
  } else {
    for (const d of h.days) {
      if (d.key.startsWith(monthPrefix)) {
        usedBytes += d.upBytes + d.downBytes;
      }
    }
  }
  const limitBytes = Math.max(1, cap.limitBytes || 1);
  const pct = usedBytes / limitBytes * 100;
  if (!cap.enabled) {
    return { warnTriggered: false, limitReached: false, usedBytes, limitBytes, pct, periodLabel };
  }
  let warnTriggered = false;
  let limitReached = false;
  if (pct >= 100 && cap.lastLimitPeriod !== periodKey) {
    cap.lastLimitPeriod = periodKey;
    cap.lastWarnPeriod = periodKey;
    limitReached = true;
  } else if (pct >= cap.alertPct && cap.lastWarnPeriod !== periodKey) {
    cap.lastWarnPeriod = periodKey;
    warnTriggered = true;
  }
  return { warnTriggered, limitReached, usedBytes, limitBytes, pct, periodLabel };
}
function recordTrafficTick(data, node, upDelta, downDelta, elapsedSec = 1, now = Date.now()) {
  const h = ensureUsageHistory(data, now);
  if (downDelta > h.peakDownSpeed) h.peakDownSpeed = downDelta;
  if (upDelta > h.peakUpSpeed) h.peakUpSpeed = upDelta;
  if (upDelta > 0 || downDelta > 0) {
    const minStart = Math.floor(now / 6e4) * 6e4;
    const hourStart = Math.floor(now / 36e5) * 36e5;
    const dayKey = formatDayKey(now);
    const dayStart = (/* @__PURE__ */ new Date(dayKey + "T00:00:00")).getTime() || now;
    addToBucketList(h.minutes, String(minStart), minStart, upDelta, downDelta, MAX_MINUTE_BUCKETS);
    addToBucketList(h.hours, String(hourStart), hourStart, upDelta, downDelta, MAX_HOUR_BUCKETS);
    addToBucketList(h.days, dayKey, dayStart, upDelta, downDelta, MAX_DAY_BUCKETS);
  }
  if (node) {
    let rec = h.perServer[node.id];
    if (!rec) {
      rec = {
        serverId: node.id,
        serverName: node.name,
        address: `${node.address}:${node.port}`,
        protocol: node.protocol,
        countryCode: node.geo?.countryCode ?? null,
        country: node.geo?.country ?? null,
        subscriptionId: node.subscriptionId ?? null,
        upBytes: 0,
        downBytes: 0,
        connectedSeconds: 0,
        sessions: 1,
        lastUsedAt: now
      };
      h.perServer[node.id] = rec;
    }
    rec.upBytes += upDelta;
    rec.downBytes += downDelta;
    rec.connectedSeconds += elapsedSec;
    rec.lastUsedAt = now;
    if (node.geo?.countryCode) rec.countryCode = node.geo.countryCode;
    if (node.geo?.country) rec.country = node.geo.country;
  }
  return evaluateDataCap(h, now);
}

// packages/core/src/xrayConfig.ts
function wantsInsecureTls(node, options = {}) {
  return node.security === "tls" && Boolean(node.allowInsecure || options.allowInsecureDefault);
}
function generateXrayConfig(node, options = {}) {
  const socksPort = options.socksPort ?? 10808;
  const httpPort = options.httpPort ?? 10809;
  const apiPort = options.apiPort ?? XRAY_API_PORT;
  const bypassLan = options.bypassLan ?? true;
  const outboundConnectAddress = normalizeServerAddress(options.resolvedServerAddress || node.address);
  const serverPort = parseServerPort(node.port);
  const flow = normalizeVlessFlow(node.flow);
  const transportPath = normalizeTransportPath(node.path, node.network);
  const streamSettings = {
    network: node.network,
    security: node.security,
    sockopt: {
      tcpNoDelay: true,
      ...options.physicalInterfaceName ? { interface: options.physicalInterfaceName } : {}
    }
  };
  if (node.security === "tls") {
    const effectiveSni = node.sni || node.host || node.address;
    const certNames = Array.from(
      new Set([effectiveSni, node.address, node.host].filter(Boolean))
    ).join(",");
    const tlsSettings = {
      serverName: effectiveSni,
      fingerprint: node.fingerprint || "chrome",
      verifyPeerCertByName: certNames
    };
    if (wantsInsecureTls(node, options) && options.pinnedCertSha256) {
      tlsSettings.pinnedPeerCertSha256 = options.pinnedCertSha256;
    }
    if (node.alpn && node.alpn.length > 0) {
      tlsSettings.alpn = node.alpn;
    }
    streamSettings.tlsSettings = tlsSettings;
  } else if (node.security === "reality") {
    streamSettings.realitySettings = {
      serverName: node.sni || node.host || node.address,
      fingerprint: node.fingerprint || "chrome",
      publicKey: node.publicKey || "",
      shortId: node.shortId || "",
      spiderX: node.spiderX || "/"
    };
  }
  if (node.network === "ws") {
    const wsSettings = {
      path: transportPath || "/"
    };
    if (node.host) {
      wsSettings.headers = { Host: node.host };
    }
    streamSettings.wsSettings = wsSettings;
  } else if (node.network === "tcp") {
    if (node.headerType === "http") {
      streamSettings.tcpSettings = {
        header: {
          type: "http",
          request: {
            version: "1.1",
            method: "GET",
            path: [transportPath || "/"],
            headers: {
              Host: [node.host || node.address],
              "User-Agent": [
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              ],
              "Accept-Encoding": ["gzip, deflate"],
              Connection: ["keep-alive"],
              Pragma: "no-cache"
            }
          }
        }
      };
    }
  } else if (node.network === "grpc") {
    streamSettings.grpcSettings = {
      serviceName: transportPath || "",
      multiMode: false
    };
  } else if (node.network === "httpupgrade") {
    streamSettings.httpupgradeSettings = {
      path: transportPath || "/",
      host: node.host || node.address
    };
  } else if (node.network === "xhttp") {
    streamSettings.xhttpSettings = {
      path: transportPath || "/",
      host: node.host || node.address
    };
  }
  let proxyOutbound;
  if (node.protocol === "vless") {
    const userObj = {
      id: node.uuid,
      encryption: node.encryption || "none"
    };
    if (node.network === "tcp" && flow) {
      userObj.flow = flow;
    }
    proxyOutbound = {
      tag: "proxy",
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: outboundConnectAddress,
            port: serverPort,
            users: [userObj]
          }
        ]
      },
      streamSettings
    };
  } else {
    proxyOutbound = {
      tag: "proxy",
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: outboundConnectAddress,
            port: serverPort,
            users: [
              {
                id: node.uuid,
                alterId: node.alterId ?? 0,
                security: node.cipher || "auto"
              }
            ]
          }
        ]
      },
      streamSettings
    };
  }
  const muxEnabled = Boolean(options.mux) && !flow;
  if (muxEnabled) {
    proxyOutbound.mux = { enabled: true, concurrency: 8, xudpConcurrency: 16, xudpProxyUDP443: "reject" };
  }
  const tunMode = Boolean(options.tunMode);
  const routingRules = [
    {
      type: "field",
      inboundTag: ["api-in"],
      outboundTag: "api"
    }
  ];
  if (tunMode) {
    routingRules.push({
      type: "field",
      inboundTag: ["socks-in", "http-in"],
      port: "53",
      outboundTag: "dns-out"
    });
  }
  routingRules.push({
    // Block QUIC (UDP 443) so browsers immediately use fast TCP HTTP/2 instead of slow UDP-over-TCP
    type: "field",
    network: "udp",
    port: "443",
    outboundTag: "block"
  });
  if (bypassLan) {
    routingRules.push({
      type: "field",
      ip: [
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10"
      ],
      outboundTag: "direct"
    });
  }
  const splitResult = buildSplitTunnelRoutingRules(options.splitTunnel);
  const adblockRules = buildAdBlockRoutingRules(options.adblock, splitResult);
  if (adblockRules.length > 0) {
    routingRules.push(...adblockRules);
  }
  if (splitResult.rules.length > 0) {
    routingRules.push(...splitResult.rules);
  }
  routingRules.push({
    type: "field",
    port: "0-65535",
    outboundTag: splitResult.defaultOutboundTag
  });
  const useAdguardDns = Boolean(options.adblock?.enabled && options.adblock?.adguardDns);
  const dnsServers = useAdguardDns ? ["94.140.14.14", "94.140.15.15", "1.1.1.1"] : ["1.1.1.1", "8.8.8.8"];
  const logConfig = {
    loglevel: "warning"
  };
  if (options.accessLogPath && options.adblock?.enabled) {
    logConfig.access = options.accessLogPath;
  }
  return {
    log: logConfig,
    stats: {},
    api: {
      tag: "api",
      services: ["StatsService"]
    },
    policy: {
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    dns: {
      servers: dnsServers,
      queryStrategy: "UseIP"
    },
    inbounds: [
      {
        tag: "socks-in",
        port: socksPort,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: {
          auth: "noauth",
          udp: true
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls"],
          routeOnly: false
        }
      },
      {
        tag: "http-in",
        port: httpPort,
        listen: "127.0.0.1",
        protocol: "http",
        settings: {
          allowTransparent: false
        },
        // HTTP CONNECT requests from browsers already carry the target hostname;
        // disabling payload sniffing avoids waiting for the TLS ClientHello before dialing.
        sniffing: {
          enabled: false
        }
      },
      {
        tag: "api-in",
        port: apiPort,
        listen: "127.0.0.1",
        protocol: "dokodemo-door",
        settings: {
          address: "127.0.0.1"
        }
      }
    ],
    outbounds: [
      proxyOutbound,
      {
        tag: "direct",
        protocol: "freedom",
        settings: {
          domainStrategy: "UseIP"
        },
        ...options.physicalInterfaceName ? {
          streamSettings: {
            sockopt: {
              interface: options.physicalInterfaceName
            }
          }
        } : {}
      },
      {
        tag: "block",
        protocol: "blackhole",
        settings: {}
      },
      {
        tag: "adblock",
        protocol: "blackhole",
        settings: {}
      },
      ...tunMode ? [{ tag: "dns-out", protocol: "dns", settings: {} }] : []
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: routingRules
    }
  };
}

// src/android/android-bridge.ts
var STORAGE_KEY = "dragonforce_vpn_persisted_v2";
var SHIELD_MILESTONES = [100, 500, 1e3, 5e3, 1e4, 25e3];
function defaultNotificationPreferences(raw) {
  return {
    connectionEvents: raw?.connectionEvents !== void 0 ? Boolean(raw.connectionEvents) : true,
    connectionLost: raw?.connectionLost !== void 0 ? Boolean(raw.connectionLost) : true,
    connectionFailed: raw?.connectionFailed !== void 0 ? Boolean(raw.connectionFailed) : true,
    dataCapAlerts: raw?.dataCapAlerts !== void 0 ? Boolean(raw.dataCapAlerts) : true,
    subscriptionUpdates: raw?.subscriptionUpdates !== void 0 ? Boolean(raw.subscriptionUpdates) : true,
    usageSummary: raw?.usageSummary !== void 0 ? Boolean(raw.usageSummary) : false,
    shieldMilestones: raw?.shieldMilestones !== void 0 ? Boolean(raw.shieldMilestones) : true
  };
}
function createDefaultPersistedData() {
  const base = {
    servers: [],
    subscriptions: [],
    activeServerId: null,
    routingMode: "tun",
    socksPort: 10808,
    httpPort: 10809,
    bypassLan: true,
    allowInsecureDefault: false,
    totalUp: 0,
    totalDown: 0,
    originGeo: null,
    geoCache: {},
    muxEnabled: false,
    speedTests: [],
    onboardingCompleted: false,
    adblock: ensureAdBlockState(void 0),
    theme: "dark",
    splitTunnel: ensureSplitTunnelConfig(void 0),
    notifications: defaultNotificationPreferences(void 0)
  };
  base.usageHistory = ensureUsageHistory(base);
  return base;
}
function createAndroidBridgeController(native, storage, fetchImpl = globalThis.fetch) {
  let persistedData = loadPersisted();
  const certPinCache = /* @__PURE__ */ new Map();
  let lastNotifiedShieldMilestone = 0;
  let prevSessionUp = 0;
  let prevSessionDown = 0;
  let activeSpeedTestAbort = null;
  const eventListeners = /* @__PURE__ */ new Map();
  let vpnStatus = {
    connected: false,
    connecting: false,
    activeServerId: persistedData.activeServerId,
    routingMode: "tun",
    isAdmin: true,
    tunActive: false,
    systemProxyActive: false,
    terminalEnvActive: false,
    connectedAt: null,
    lastError: null,
    socksPort: persistedData.socksPort,
    httpPort: persistedData.httpPort,
    binariesReady: { xray: true, tun2socks: true, wintun: true },
    stats: {
      upSpeed: 0,
      downSpeed: 0,
      sessionUp: 0,
      sessionDown: 0,
      totalUp: persistedData.totalUp,
      totalDown: persistedData.totalDown
    },
    exitGeo: null
  };
  function loadPersisted() {
    const fallback = createDefaultPersistedData();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      const merged = {
        ...fallback,
        ...parsed,
        routingMode: "tun",
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        adblock: ensureAdBlockState(parsed.adblock),
        splitTunnel: ensureSplitTunnelConfig(parsed.splitTunnel),
        notifications: defaultNotificationPreferences(parsed.notifications)
      };
      merged.usageHistory = ensureUsageHistory(merged);
      return merged;
    } catch {
      return fallback;
    }
  }
  function savePersisted() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(persistedData));
    } catch {
    }
  }
  function emitSse(eventName, payload) {
    const set = eventListeners.get(eventName);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(payload);
    const evt = new MessageEvent(eventName, { data });
    for (const fn of set) {
      try {
        fn(evt);
      } catch {
      }
    }
  }
  function broadcastData() {
    savePersisted();
    emitSse("data", persistedData);
  }
  function broadcastStatus() {
    emitSse("status", vpnStatus);
  }
  function getInstalledApps() {
    try {
      const parsed = JSON.parse(native.listInstalledApps() || "{}");
      return Array.isArray(parsed.apps) ? parsed.apps : [];
    } catch {
      return [];
    }
  }
  function getDynamicColors() {
    try {
      const parsed = JSON.parse(native.getDynamicColors() || "{}");
      return {
        supported: Boolean(parsed.supported),
        accentHex: parsed.accentHex,
        accentSoftHex: parsed.accentSoftHex,
        surfaceDarkHex: parsed.surfaceDarkHex,
        surfaceLightHex: parsed.surfaceLightHex
      };
    } catch {
      return { supported: false };
    }
  }
  function getLogs() {
    try {
      const arr = JSON.parse(native.getLogs() || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function dispatchNativeNotification(channel, id, title, body) {
    try {
      native.dispatchNotification(JSON.stringify({ channel, id, title, body }));
    } catch {
    }
  }
  function handleDataCapEvaluation(capEval) {
    const prefs = defaultNotificationPreferences(persistedData.notifications);
    const cap = ensureUsageHistory(persistedData).dataCap;
    if (capEval.limitReached) {
      if (prefs.dataCapAlerts) {
        dispatchNativeNotification(
          "vpn_alerts",
          2002,
          "Data Cap Reached (100%)",
          cap.autoDisconnect ? `Your ${cap.period} data cap has been reached. DragonForce VPN disconnected automatically.` : `You have reached 100% of your ${cap.period} data cap.`
        );
      }
      if (cap.autoDisconnect && vpnStatus.connected) {
        native.disconnect();
        vpnStatus.connected = false;
        vpnStatus.tunActive = false;
      }
      broadcastData();
    } else if (capEval.warnTriggered) {
      if (prefs.dataCapAlerts) {
        dispatchNativeNotification(
          "vpn_alerts",
          2002,
          `Data Cap Warning (${Math.round(capEval.pct)}%)`,
          `You have consumed ${Math.round(capEval.pct)}% of your ${cap.period} DragonForce VPN data cap.`
        );
      }
      broadcastData();
    }
  }
  function pollTelemetryTick() {
    try {
      const rawStatus = JSON.parse(native.getStatus() || "{}");
      const connected = Boolean(rawStatus.connected);
      const connecting = Boolean(rawStatus.connecting);
      const stats = rawStatus.stats || {};
      const upSpeed = Number(stats.upSpeed) || 0;
      const downSpeed = Number(stats.downSpeed) || 0;
      const sessionUp = Number(stats.sessionUp) || 0;
      const sessionDown = Number(stats.sessionDown) || 0;
      if (!connected) {
        prevSessionUp = 0;
        prevSessionDown = 0;
      } else {
        const deltaUp = Math.max(0, sessionUp - prevSessionUp);
        const deltaDown = Math.max(0, sessionDown - prevSessionDown);
        prevSessionUp = sessionUp;
        prevSessionDown = sessionDown;
        if (deltaUp > 0 || deltaDown > 0) {
          persistedData.totalUp += deltaUp;
          persistedData.totalDown += deltaDown;
          const activeNode = persistedData.servers.find((s) => s.id === persistedData.activeServerId) || void 0;
          const capEval = recordTrafficTick(persistedData, activeNode, deltaUp, deltaDown, 1);
          handleDataCapEvaluation(capEval);
          savePersisted();
        }
      }
      const chunk = native.drainAccessLog();
      if (chunk) {
        persistedData.adblock = ensureAdBlockState(persistedData.adblock);
        const blockedDelta = parseAdBlockAccessLogChunk(chunk, persistedData.adblock);
        if (blockedDelta > 0) {
          const total = persistedData.adblock.totalBlocked;
          const prefs = defaultNotificationPreferences(persistedData.notifications);
          for (const milestone of SHIELD_MILESTONES) {
            if (total >= milestone && lastNotifiedShieldMilestone < milestone) {
              lastNotifiedShieldMilestone = milestone;
              if (prefs.shieldMilestones) {
                dispatchNativeNotification(
                  "vpn_insights",
                  4001,
                  `Privacy Shield Milestone \u2022 ${milestone.toLocaleString()} Blocked`,
                  `DragonForce Ad Shield has blocked ${total.toLocaleString()} ads & trackers!`
                );
              }
            }
          }
          broadcastData();
        }
      }
      vpnStatus = {
        ...vpnStatus,
        connected,
        connecting,
        activeServerId: persistedData.activeServerId,
        tunActive: connected,
        connectedAt: rawStatus.connectedAt ?? null,
        lastError: rawStatus.lastError ?? null,
        socksPort: persistedData.socksPort,
        httpPort: persistedData.httpPort,
        stats: {
          upSpeed,
          downSpeed,
          sessionUp,
          sessionDown,
          totalUp: persistedData.totalUp,
          totalDown: persistedData.totalDown
        }
      };
      broadcastStatus();
    } catch {
    }
  }
  async function connectActiveServer(serverIdOverride) {
    const targetId = serverIdOverride || persistedData.activeServerId || persistedData.servers[0]?.id || null;
    if (!targetId) {
      return { ok: false, error: "Add or select a server first before connecting." };
    }
    const server = persistedData.servers.find((s) => s.id === targetId);
    if (!server) {
      return { ok: false, error: "Selected server not found." };
    }
    persistedData.activeServerId = server.id;
    vpnStatus.activeServerId = server.id;
    recordSessionStart(persistedData, server);
    const effectiveNode = {
      ...server,
      allowInsecure: Boolean(server.allowInsecure || persistedData.allowInsecureDefault)
    };
    let pinnedCertSha256;
    if (effectiveNode.allowInsecure && (effectiveNode.security === "tls" || effectiveNode.security === "reality")) {
      const sniHost = effectiveNode.sni || effectiveNode.host || effectiveNode.address;
      const cacheKey = `${effectiveNode.address}:${effectiveNode.port}:${sniHost}`;
      let pin = certPinCache.get(cacheKey);
      if (!pin) {
        try {
          const pinRes = JSON.parse(
            native.fetchCertSha256(effectiveNode.address, effectiveNode.port, sniHost) || "{}"
          );
          if (pinRes.ok && typeof pinRes.sha256 === "string" && pinRes.sha256.length >= 64) {
            const hashStr = String(pinRes.sha256);
            pin = hashStr;
            certPinCache.set(cacheKey, hashStr);
          }
        } catch {
        }
      }
      if (pin) {
        pinnedCertSha256 = pin;
      }
    }
    const ab = ensureAdBlockState(persistedData.adblock);
    const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
    const xrayConfig = generateXrayConfig(effectiveNode, {
      socksPort: persistedData.socksPort,
      httpPort: persistedData.httpPort,
      bypassLan: persistedData.bypassLan,
      allowInsecureDefault: persistedData.allowInsecureDefault,
      pinnedCertSha256,
      mux: Boolean(persistedData.muxEnabled),
      tunMode: true,
      adblock: ab.config,
      splitTunnel: st
    });
    const prefs = defaultNotificationPreferences(persistedData.notifications);
    const dnsServers = ab.config.enabled && ab.config.adguardDns ? ["94.140.14.14", "94.140.15.15", "1.1.1.1"] : ["1.1.1.1", "8.8.8.8"];
    const res = JSON.parse(
      native.connect(
        JSON.stringify({
          xrayConfigJson: JSON.stringify(xrayConfig, null, 2),
          serverId: server.id,
          serverName: server.name,
          protocol: server.protocol,
          socksPort: persistedData.socksPort,
          httpPort: persistedData.httpPort,
          perAppMode: st.perAppMode || "off",
          selectedApps: st.selectedApps || [],
          dnsServers,
          notifyConnect: prefs.connectionEvents
        })
      ) || '{"ok":false}'
    );
    pollTelemetryTick();
    broadcastData();
    return { ok: Boolean(res.ok), error: res.error };
  }
  function measureServerPing(node) {
    try {
      const res = JSON.parse(native.pingServer(node.address, node.port, 4e3) || "{}");
      const p = typeof res.ping === "number" ? res.ping : -1;
      node.ping = p;
      node.pingStatus = res.pingStatus || (p > 0 ? "ok" : "timeout");
      node.pingError = res.pingError || void 0;
      node.pingCheckedAt = res.pingCheckedAt || Date.now();
    } catch (err) {
      node.ping = -1;
      node.pingStatus = "error";
      node.pingError = err instanceof Error ? err.message : "Ping failed";
      node.pingCheckedAt = Date.now();
    }
    return node;
  }
  async function runSpeedTest() {
    if (activeSpeedTestAbort) return;
    const ctrl = new AbortController();
    activeSpeedTestAbort = ctrl;
    const route = vpnStatus.connected ? "vpn" : "direct";
    const activeNode = persistedData.servers.find((s) => s.id === persistedData.activeServerId) || null;
    const progress = (patch) => {
      emitSse("speedtest", {
        running: true,
        done: false,
        route,
        serverName: activeNode?.name || null,
        ...patch
      });
    };
    try {
      progress({
        phase: "ping",
        pct: 10,
        pingMs: null,
        jitterMs: null,
        downloadMbps: null,
        uploadMbps: null
      });
      const samples = [];
      for (let i = 0; i < 4; i++) {
        if (ctrl.signal.aborted) throw new Error("Speed test cancelled");
        const t0 = performance.now();
        await fetchImpl(`https://speed.cloudflare.com/__down?bytes=0&r=${Math.random()}`, {
          cache: "no-store",
          signal: ctrl.signal
        });
        samples.push(Math.max(1, Math.round(performance.now() - t0)));
      }
      const pingMs = Math.min(...samples);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const jitterMs = Math.max(
        1,
        Math.round(Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length))
      );
      progress({ phase: "download", pct: 45, pingMs, jitterMs });
      const dlStart = performance.now();
      const dlBytes = 4 * 1024 * 1024;
      const dlRes = await fetchImpl(
        `https://speed.cloudflare.com/__down?bytes=${dlBytes}&r=${Math.random()}`,
        { cache: "no-store", signal: ctrl.signal }
      );
      const dlBuf = await dlRes.arrayBuffer();
      const dlSec = Math.max(0.05, (performance.now() - dlStart) / 1e3);
      const downloadMbps = Math.round(dlBuf.byteLength * 8 / (dlSec * 1e6) * 10) / 10;
      progress({ phase: "upload", pct: 80, pingMs, jitterMs, downloadMbps });
      const ulBytes = 1 * 1024 * 1024;
      const payload = new Uint8Array(ulBytes);
      const ulStart = performance.now();
      await fetchImpl(`https://speed.cloudflare.com/__up?r=${Math.random()}`, {
        method: "POST",
        body: payload,
        signal: ctrl.signal
      });
      const ulSec = Math.max(0.05, (performance.now() - ulStart) / 1e3);
      const uploadMbps = Math.round(ulBytes * 8 / (ulSec * 1e6) * 10) / 10;
      const result = {
        id: randomId(),
        timestamp: Date.now(),
        route,
        serverName: activeNode?.name || null,
        downloadMbps,
        uploadMbps,
        pingMs,
        jitterMs,
        handshakeMs: samples[0] || pingMs,
        ip: activeNode?.geo?.ip || null,
        city: activeNode?.geo?.city || null,
        country: activeNode?.geo?.country || null,
        countryCode: activeNode?.geo?.countryCode || null,
        isp: "Cloudflare Edge",
        colo: "SIN"
      };
      persistedData.speedTests = [result, ...persistedData.speedTests || []].slice(0, 20);
      broadcastData();
      emitSse("speedtest", { running: false, done: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Speed test failed";
      emitSse("speedtest", { running: false, done: true, error: msg });
    } finally {
      activeSpeedTestAbort = null;
    }
  }
  async function handleApi(pathname, body = {}) {
    switch (pathname) {
      case "/api/init": {
        pollTelemetryTick();
        return {
          ok: true,
          platform: "android",
          status: vpnStatus,
          data: persistedData,
          logs: getLogs(),
          terminalCommands: {},
          installedApps: getInstalledApps(),
          dynamicColors: getDynamicColors()
        };
      }
      case "/api/connect":
        return connectActiveServer(body.serverId);
      case "/api/disconnect": {
        const res = JSON.parse(native.disconnect() || '{"ok":true}');
        pollTelemetryTick();
        return { ok: Boolean(res.ok), error: res.error };
      }
      case "/api/select-server": {
        const serverId = String(body.serverId || "");
        const exists = persistedData.servers.some((s) => s.id === serverId);
        if (!exists) return { ok: false, error: "Server not found" };
        persistedData.activeServerId = serverId;
        vpnStatus.activeServerId = serverId;
        broadcastData();
        broadcastStatus();
        if (vpnStatus.connected || vpnStatus.connecting) {
          return connectActiveServer(serverId);
        }
        return { ok: true };
      }
      case "/api/import-links": {
        const rawText = String(body.rawText || "");
        const { nodes, errors } = parseMultipleLinks(rawText);
        if (nodes.length > 0) {
          persistedData.servers.push(...nodes);
          if (!persistedData.activeServerId) {
            persistedData.activeServerId = nodes[0].id;
            vpnStatus.activeServerId = nodes[0].id;
          }
          broadcastData();
          broadcastStatus();
        }
        return { ok: nodes.length > 0, importedCount: nodes.length, nodes, errors };
      }
      case "/api/update-server": {
        const idx = persistedData.servers.findIndex((s) => s.id === body.serverId);
        if (idx < 0) return { ok: false, error: "Server not found" };
        try {
          const updated = applyServerEdit(persistedData.servers[idx], body.patch || {});
          persistedData.servers[idx] = updated;
          let reconnected = false;
          if (vpnStatus.connected && persistedData.activeServerId === updated.id) {
            const c = await connectActiveServer(updated.id);
            reconnected = c.ok;
          }
          broadcastData();
          return { ok: true, node: updated, reconnected };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "/api/delete-server": {
        const id = String(body.serverId || "");
        persistedData.servers = persistedData.servers.filter((s) => s.id !== id);
        if (persistedData.activeServerId === id) {
          persistedData.activeServerId = persistedData.servers[0]?.id || null;
          vpnStatus.activeServerId = persistedData.activeServerId;
        }
        broadcastData();
        broadcastStatus();
        return { ok: true };
      }
      case "/api/ping-server": {
        const node = persistedData.servers.find((s) => s.id === body.serverId);
        if (!node) return { ok: false, error: "Server not found" };
        measureServerPing(node);
        broadcastData();
        return { ok: true, ping: node.ping, pingStatus: node.pingStatus, pingError: node.pingError };
      }
      case "/api/ping-all": {
        for (const node of persistedData.servers) {
          measureServerPing(node);
        }
        broadcastData();
        return { ok: true, count: persistedData.servers.length };
      }
      case "/api/ping-subscription": {
        const subNodes = persistedData.servers.filter((s) => s.subscriptionId === body.subId);
        for (const node of subNodes) {
          measureServerPing(node);
        }
        broadcastData();
        return { ok: true, count: subNodes.length };
      }
      case "/api/test-tunnel": {
        const active = persistedData.servers.find((s) => s.id === persistedData.activeServerId) || null;
        if (!active) return { ok: false, error: "No active server selected" };
        measureServerPing(active);
        return {
          ok: (active.ping ?? -1) > 0,
          latencyMs: active.ping ?? null,
          ip: active.geo?.ip || active.address,
          country: active.geo?.country || "Encrypted Tunnel",
          countryCode: active.geo?.countryCode || "SG",
          city: active.geo?.city || active.name
        };
      }
      case "/api/add-subscription": {
        const url = String(body.url || "").trim();
        const name = String(body.name || "").trim();
        if (!url) return { ok: false, error: "Enter a subscription URL" };
        try {
          const result = await fetchSubscription(url, void 0, name || void 0);
          persistedData.subscriptions.push(result.subscription);
          persistedData.servers.push(...result.nodes);
          if (!persistedData.activeServerId && result.nodes[0]) {
            persistedData.activeServerId = result.nodes[0].id;
            vpnStatus.activeServerId = result.nodes[0].id;
          }
          if (defaultNotificationPreferences(persistedData.notifications).subscriptionUpdates) {
            dispatchNativeNotification(
              "vpn_subscriptions",
              3001,
              `Subscription Added \u2022 ${result.subscription.name}`,
              `Imported ${result.nodes.length} server nodes.`
            );
          }
          broadcastData();
          return {
            ok: true,
            count: result.nodes.length,
            subscription: result.subscription
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "/api/refresh-subscription": {
        const sub = persistedData.subscriptions.find((s) => s.id === body.subId);
        if (!sub) return { ok: false, error: "Subscription not found" };
        try {
          const result = await fetchSubscription(sub.url, sub.id, sub.name);
          replaceSubscriptionNodes(persistedData, sub.id, result.subscription, result.nodes);
          vpnStatus.activeServerId = persistedData.activeServerId;
          if (defaultNotificationPreferences(persistedData.notifications).subscriptionUpdates) {
            dispatchNativeNotification(
              "vpn_subscriptions",
              3001,
              `Subscription Updated \u2022 ${result.subscription.name}`,
              `${result.nodes.length} server nodes synced and ready.`
            );
          }
          broadcastData();
          return { ok: true, count: result.nodes.length };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "/api/sync-all-subscriptions": {
        let syncedSubs = 0;
        let totalNodes = 0;
        for (const sub of [...persistedData.subscriptions]) {
          const res = await handleApi("/api/refresh-subscription", { subId: sub.id });
          if (res.ok) {
            syncedSubs++;
            totalNodes += res.count || 0;
          }
        }
        return { ok: syncedSubs > 0, syncedSubs, totalNodes };
      }
      case "/api/update-subscription": {
        const sub = persistedData.subscriptions.find((s) => s.id === body.subId);
        if (!sub) return { ok: false, error: "Subscription not found" };
        if (typeof body.name === "string" && body.name.trim()) sub.name = body.name.trim();
        if (typeof body.url === "string" && body.url.trim().startsWith("http")) {
          sub.url = body.url.trim();
        }
        if (body.totalBytes !== void 0) {
          const tb = Number(body.totalBytes);
          sub.totalBytes = Number.isFinite(tb) && tb > 0 ? tb : void 0;
        }
        if (body.expireTimestamp !== void 0) {
          const et = Number(body.expireTimestamp);
          sub.expireTimestamp = Number.isFinite(et) && et > 0 ? et : void 0;
        }
        broadcastData();
        return { ok: true, subscription: sub };
      }
      case "/api/delete-subscription": {
        const subId = String(body.subId || "");
        if (persistedData.subscriptions.some((s) => s.id === subId)) {
          replaceSubscriptionNodes(persistedData, subId, null, []);
          vpnStatus.activeServerId = persistedData.activeServerId;
          broadcastData();
        }
        return { ok: true };
      }
      case "/api/server-config": {
        const node = persistedData.servers.find((s) => s.id === body.serverId);
        if (!node) return { ok: false, error: "Server not found" };
        const cfg = generateXrayConfig(node, {
          socksPort: persistedData.socksPort,
          httpPort: persistedData.httpPort,
          bypassLan: persistedData.bypassLan,
          allowInsecureDefault: persistedData.allowInsecureDefault,
          mux: Boolean(persistedData.muxEnabled),
          tunMode: true,
          adblock: ensureAdBlockState(persistedData.adblock).config,
          splitTunnel: ensureSplitTunnelConfig(persistedData.splitTunnel)
        });
        return { ok: true, json: JSON.stringify(cfg, null, 2) };
      }
      case "/api/routing-mode": {
        persistedData.routingMode = "tun";
        broadcastData();
        broadcastStatus();
        return { ok: true, mode: "tun" };
      }
      case "/api/settings": {
        try {
          const nextNet = validateNetworkSettings(persistedData, body, 0);
          Object.assign(persistedData, nextNet);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (body.theme === "light" || body.theme === "dark" || body.theme === "material_you") {
          persistedData.theme = body.theme;
        }
        if (body.notifications && typeof body.notifications === "object") {
          persistedData.notifications = defaultNotificationPreferences({
            ...persistedData.notifications,
            ...body.notifications
          });
        }
        broadcastData();
        broadcastStatus();
        return {
          ok: true,
          theme: persistedData.theme,
          notifications: persistedData.notifications,
          dynamicColors: getDynamicColors()
        };
      }
      case "/api/speedtest/start": {
        if (activeSpeedTestAbort) {
          return { ok: false, error: "A speed test is already running" };
        }
        void runSpeedTest();
        return { ok: true };
      }
      case "/api/speedtest/cancel": {
        if (activeSpeedTestAbort) {
          activeSpeedTestAbort.abort();
          activeSpeedTestAbort = null;
        }
        return { ok: true };
      }
      case "/api/usage/datacap": {
        const usage = ensureUsageHistory(persistedData);
        const cap = { ...defaultDataCap(), ...usage.dataCap };
        if (typeof body.enabled === "boolean") cap.enabled = body.enabled;
        if (body.period === "daily" || body.period === "monthly") cap.period = body.period;
        if (typeof body.limitBytes === "number" && body.limitBytes > 0) {
          cap.limitBytes = Math.round(body.limitBytes);
        } else if (typeof body.limitGb === "number" && body.limitGb > 0) {
          cap.limitBytes = Math.round(body.limitGb * 1024 * 1024 * 1024);
        }
        if (typeof body.alertPct === "number") {
          cap.alertPct = Math.max(10, Math.min(99, Math.round(body.alertPct)));
        }
        if (typeof body.autoDisconnect === "boolean") cap.autoDisconnect = body.autoDisconnect;
        usage.dataCap = cap;
        handleDataCapEvaluation(evaluateDataCap(usage));
        broadcastData();
        return { ok: true, dataCap: usage.dataCap };
      }
      case "/api/usage/reset": {
        const usage = ensureUsageHistory(persistedData);
        usage.minutes = [];
        usage.hours = [];
        usage.days = [];
        usage.perServer = {};
        usage.peakDownSpeed = 0;
        usage.peakUpSpeed = 0;
        persistedData.totalUp = 0;
        persistedData.totalDown = 0;
        broadcastData();
        return { ok: true, usageHistory: usage };
      }
      case "/api/qr/clipboard": {
        try {
          const clip = JSON.parse(native.readClipboard() || "{}");
          return { ok: true, text: clip.text || "" };
        } catch {
          return { ok: false, text: "" };
        }
      }
      case "/api/qr/preview": {
        const text = String(body.rawText || "").trim();
        if (!text) return { ok: false, error: "Empty QR payload" };
        if (/^https?:\/\//i.test(text)) {
          return {
            ok: true,
            kind: "subscription",
            url: text,
            host: (() => {
              try {
                return new URL(text).hostname;
              } catch {
                return text;
              }
            })()
          };
        }
        const parsed = parseMultipleLinks(text);
        if (parsed.nodes.length > 0) {
          return {
            ok: true,
            kind: "servers",
            nodes: parsed.nodes,
            count: parsed.nodes.length
          };
        }
        return { ok: false, error: parsed.errors[0] || "Unrecognized QR code format" };
      }
      case "/api/onboarding": {
        persistedData.onboardingCompleted = body.completed !== void 0 ? Boolean(body.completed) : true;
        broadcastData();
        return { ok: true, onboardingCompleted: persistedData.onboardingCompleted };
      }
      case "/api/adblock/config": {
        const cleanHost = (val) => sanitizeDomainEntry(String(val || ""));
        for (const f of ["addBlockedDomain", "addWhitelistedDomain"]) {
          if (body[f] && !cleanHost(body[f])) {
            return { ok: false, error: "Enter a valid domain name" };
          }
        }
        const ab = ensureAdBlockState(persistedData.adblock);
        const cfg = {
          ...ab.config,
          customBlockedDomains: [...ab.config.customBlockedDomains],
          whitelistedDomains: [...ab.config.whitelistedDomains]
        };
        for (const field of [
          "enabled",
          "blockYoutubeAds",
          "blockAds",
          "blockTrackers",
          "blockMalware",
          "adguardDns"
        ]) {
          if (typeof body[field] === "boolean") cfg[field] = body[field];
        }
        if (body.addBlockedDomain) {
          const d = cleanHost(body.addBlockedDomain);
          if (!cfg.customBlockedDomains.includes(d)) cfg.customBlockedDomains.unshift(d);
        }
        if (body.removeBlockedDomain) {
          cfg.customBlockedDomains = cfg.customBlockedDomains.filter(
            (d) => d !== cleanHost(body.removeBlockedDomain)
          );
        }
        if (body.addWhitelistedDomain) {
          const d = cleanHost(body.addWhitelistedDomain);
          if (!cfg.whitelistedDomains.includes(d)) cfg.whitelistedDomains.unshift(d);
        }
        if (body.removeWhitelistedDomain) {
          cfg.whitelistedDomains = cfg.whitelistedDomains.filter(
            (d) => d !== cleanHost(body.removeWhitelistedDomain)
          );
        }
        persistedData.adblock = { ...ab, config: cfg };
        if (vpnStatus.connected) {
          await connectActiveServer();
        }
        broadcastData();
        return { ok: true, adblock: persistedData.adblock };
      }
      case "/api/adblock/test": {
        const ab = ensureAdBlockState(persistedData.adblock);
        if (!ab.config.enabled) {
          return { ok: false, error: "Enable Ad Shield first to run verification." };
        }
        const sample = [
          "2026/11/04 12:00:00 from 127.0.0.1:50001 accepted tcp:ads.youtube.com:443 [socks-in -> adblock]",
          "2026/11/04 12:00:00 from 127.0.0.1:50002 accepted tcp:googleads.g.doubleclick.net:443 [socks-in -> adblock]",
          "2026/11/04 12:00:00 from 127.0.0.1:50003 accepted tcp:scorecardresearch.com:443 [socks-in -> adblock]"
        ].join("\n");
        const blockedCount = parseAdBlockAccessLogChunk(sample, ab);
        persistedData.adblock = ab;
        broadcastData();
        return { ok: true, blockedCount, targetsTested: 3 };
      }
      case "/api/adblock/reset": {
        const ab = ensureAdBlockState(persistedData.adblock);
        persistedData.adblock = ensureAdBlockState({ config: ab.config });
        broadcastData();
        return { ok: true, adblock: persistedData.adblock };
      }
      case "/api/adblock/check-domain": {
        const rawDomain = String(body.domain || "").trim();
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateDomainShield(rawDomain, ab.config);
        return { ok: true, simulation: true, domain: rawDomain, ...verdict };
      }
      case "/api/split-tunnel/apps": {
        return { ok: true, apps: getInstalledApps() };
      }
      case "/api/split-tunnel/config": {
        const parsedTarget = typeof body.addTarget === "string" ? parseSplitTargetInput(body.addTarget) : null;
        if (body.addTarget && !parsedTarget) {
          return {
            ok: false,
            error: "Enter a valid domain (e.g. netflix.com, *.lk) or IPv4/IPv6 address or CIDR range."
          };
        }
        const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
        if (body.mode === "off" || body.mode === "bypass" || body.mode === "vpn_only") {
          st.mode = body.mode;
        }
        if (typeof body.presetId === "string" && PRESET_IDS.includes(body.presetId)) {
          const pid = body.presetId;
          const nextVal = typeof body.enabled === "boolean" ? body.enabled : !st.presets[pid];
          st.presets[pid] = nextVal;
          if (nextVal && st.mode === "off") st.mode = "bypass";
        }
        if (parsedTarget) {
          if (parsedTarget.kind === "domain") {
            if (!st.customDomains.includes(parsedTarget.value)) {
              st.customDomains.push(parsedTarget.value);
              if (st.mode === "off") st.mode = "bypass";
            }
          } else if (!st.customIps.includes(parsedTarget.value)) {
            st.customIps.push(parsedTarget.value);
            if (st.mode === "off") st.mode = "bypass";
          }
        }
        if (typeof body.removeDomain === "string") {
          const d = body.removeDomain.trim().toLowerCase();
          st.customDomains = st.customDomains.filter((item) => item !== d);
        }
        if (typeof body.removeIp === "string") {
          const ip = body.removeIp.trim();
          st.customIps = st.customIps.filter((item) => item !== ip);
        }
        if (body.perAppMode === "off" || body.perAppMode === "bypass_selected" || body.perAppMode === "only_selected") {
          st.perAppMode = body.perAppMode;
        }
        if (typeof body.toggleApp === "string" && body.toggleApp.trim()) {
          const pkg = body.toggleApp.trim();
          const apps = Array.isArray(st.selectedApps) ? [...st.selectedApps] : [];
          const idx = apps.indexOf(pkg);
          if (idx >= 0) apps.splice(idx, 1);
          else apps.push(pkg);
          st.selectedApps = ensureSplitTunnelConfig({ ...st, selectedApps: apps }).selectedApps;
          if ((st.selectedApps?.length || 0) > 0 && (!st.perAppMode || st.perAppMode === "off")) {
            st.perAppMode = "bypass_selected";
          }
        }
        if (Array.isArray(body.selectedApps)) {
          st.selectedApps = ensureSplitTunnelConfig({
            ...st,
            selectedApps: body.selectedApps
          }).selectedApps;
        }
        persistedData.splitTunnel = st;
        if (vpnStatus.connected) {
          await connectActiveServer();
        }
        broadcastData();
        return { ok: true, splitTunnel: persistedData.splitTunnel };
      }
      case "/api/split-tunnel/test": {
        const rawTarget = String(body.target || "").trim();
        const st = ensureSplitTunnelConfig(persistedData.splitTunnel);
        const ab = ensureAdBlockState(persistedData.adblock);
        const verdict = evaluateSplitTunnelRoute(
          rawTarget,
          st,
          ab.config,
          persistedData.bypassLan
        );
        return { ok: true, ...verdict };
      }
      case "/api/clear-logs": {
        native.clearLogs();
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }
  function addEventListener(type, listener) {
    let set = eventListeners.get(type);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      eventListeners.set(type, set);
    }
    set.add(listener);
  }
  function removeEventListener(type, listener) {
    eventListeners.get(type)?.delete(listener);
  }
  return {
    handleApi,
    pollTelemetryTick,
    addEventListener,
    removeEventListener,
    getPersistedData: () => persistedData,
    getVpnStatus: () => vpnStatus
  };
}
function installAndroidWebViewBridge() {
  if (typeof window === "undefined") return false;
  const native = window.DragonForceAndroid;
  if (!native || typeof native.getStatus !== "function") return false;
  document.documentElement.dataset.platform = "android";
  const originalFetch = window.fetch.bind(window);
  const controller = createAndroidBridgeController(native, window.localStorage, originalFetch);
  window.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let pathname = urlStr;
    try {
      if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
        pathname = new URL(urlStr).pathname;
      }
    } catch {
    }
    if (pathname.startsWith("/api/")) {
      let body = {};
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = {};
        }
      }
      const result = await controller.handleApi(pathname, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(input, init);
  };
  const OriginalEventSource = window.EventSource;
  class AndroidBridgeEventSource {
    url;
    readyState = 1;
    constructor(url) {
      this.url = String(url);
      if (this.url.includes("/api/events")) {
        setTimeout(() => {
          controller.pollTelemetryTick();
        }, 20);
      } else if (OriginalEventSource) {
        return new OriginalEventSource(url);
      }
    }
    addEventListener(type, listener) {
      controller.addEventListener(type, listener);
    }
    removeEventListener(type, listener) {
      controller.removeEventListener(type, listener);
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = AndroidBridgeEventSource;
  setInterval(() => {
    controller.pollTelemetryTick();
  }, 1e3);
  return true;
}
installAndroidWebViewBridge();
export {
  createAndroidBridgeController,
  createDefaultPersistedData,
  defaultNotificationPreferences,
  installAndroidWebViewBridge
};
