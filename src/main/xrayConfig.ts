import type { AdBlockConfig, ServerNode, SplitTunnelConfig } from './types.ts';
import { normalizeTransportPath, normalizeVlessFlow } from './parser.ts';
import { buildAdBlockRoutingRules } from './adblockEngine.ts';
import { buildSplitTunnelRoutingRules } from './splitTunnelEngine.ts';
import { XRAY_API_PORT } from './networkSettings.ts';
import { normalizeServerAddress, parseServerPort } from './serverAddress.ts';

export interface XrayConfigOptions {
  socksPort?: number;
  httpPort?: number;
  apiPort?: number;
  bypassLan?: boolean;
  allowInsecureDefault?: boolean;
  resolvedServerAddress?: string;
  /**
   * Leaf-certificate SHA-256 to pin when "allow insecure" is on. Xray ≥ 26
   * removed `allowInsecure` (configs containing it fail to load), so pinning
   * the presented certificate is how self-signed/mismatched certs are accepted.
   */
  pinnedCertSha256?: string;
  /**
   * Full-TUN mode: hijack all DNS (port 53) into Xray and answer with FakeDNS.
   * Lookups complete locally in ~1 ms; the real domain (recovered by sniffing)
   * is resolved by the VPN server. Avoids per-lookup tunnel round trips and
   * timeouts against private ISP resolvers that are unreachable through the VPN.
   */
  tunMode?: boolean;
  /** Multiplex new connections over one warm tunnel connection (default on). */
  mux?: boolean;
  /** Ad, Tracker, Malware & YouTube Ad Shield configuration. */
  adblock?: AdBlockConfig;
  /** Smart Split Tunneling configuration (Bypass VPN or VPN-Only routing). */
  splitTunnel?: SplitTunnelConfig;
  /** Optional path to Xray access log for live blocked-domain telemetry. */
  accessLogPath?: string;
  /** Physical network interface name (e.g. "Wi-Fi" or "Ethernet") so `direct` outbound bypasses TUN. */
  physicalInterfaceName?: string;
}

/** FakeDNS pool: inside the TUN adapter's 198.18.0.0/15 subnet, excluding the adapter IP. */
export const FAKE_DNS_POOL = '198.19.0.0/16';

/** True when the node (or the global setting) asks to accept unverified certificates. */
export function wantsInsecureTls(node: ServerNode, options: XrayConfigOptions = {}): boolean {
  return node.security === 'tls' && Boolean(node.allowInsecure || options.allowInsecureDefault);
}

export function generateXrayConfig(
  node: ServerNode,
  options: XrayConfigOptions = {}
): Record<string, unknown> {
  const socksPort = options.socksPort ?? 10808;
  const httpPort = options.httpPort ?? 10809;
  const apiPort = options.apiPort ?? XRAY_API_PORT;
  const bypassLan = options.bypassLan ?? true;
  const outboundConnectAddress = normalizeServerAddress(options.resolvedServerAddress || node.address);
  const serverPort = parseServerPort(node.port);
  // Saved profiles can still contain flow="none" from earlier imports.
  const flow = normalizeVlessFlow(node.flow);
  const transportPath = normalizeTransportPath(node.path, node.network);

  const streamSettings: Record<string, unknown> = {
    network: node.network,
    security: node.security,
    sockopt: {
      tcpNoDelay: true,
      ...(options.physicalInterfaceName ? { interface: options.physicalInterfaceName } : {}),
    },
  };

  if (node.security === 'tls') {
    const effectiveSni = node.sni || node.host || node.address;
    const certNames = Array.from(
      new Set([effectiveSni, node.address, node.host].filter(Boolean))
    ).join(',');

    const tlsSettings: Record<string, unknown> = {
      serverName: effectiveSni,
      fingerprint: node.fingerprint || 'chrome',
      verifyPeerCertByName: certNames,
    };
    if (wantsInsecureTls(node, options) && options.pinnedCertSha256) {
      tlsSettings.pinnedPeerCertSha256 = options.pinnedCertSha256;
    }
    if (node.alpn && node.alpn.length > 0) {
      tlsSettings.alpn = node.alpn;
    }
    streamSettings.tlsSettings = tlsSettings;
  } else if (node.security === 'reality') {
    streamSettings.realitySettings = {
      serverName: node.sni || node.host || node.address,
      fingerprint: node.fingerprint || 'chrome',
      publicKey: node.publicKey || '',
      shortId: node.shortId || '',
      spiderX: node.spiderX || '/',
    };
  }

  if (node.network === 'ws') {
    const wsSettings: Record<string, unknown> = {
      path: transportPath || '/',
    };
    if (node.host) {
      wsSettings.headers = { Host: node.host };
    }
    streamSettings.wsSettings = wsSettings;
  } else if (node.network === 'tcp') {
    if (node.headerType === 'http') {
      streamSettings.tcpSettings = {
        header: {
          type: 'http',
          request: {
            version: '1.1',
            method: 'GET',
            path: [transportPath || '/'],
            headers: {
              Host: [node.host || node.address],
              'User-Agent': [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              ],
              'Accept-Encoding': ['gzip, deflate'],
              Connection: ['keep-alive'],
              Pragma: 'no-cache',
            },
          },
        },
      };
    }
  } else if (node.network === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: transportPath || '',
      multiMode: false,
    };
  } else if (node.network === 'httpupgrade') {
    streamSettings.httpupgradeSettings = {
      path: transportPath || '/',
      host: node.host || node.address,
    };
  } else if (node.network === 'xhttp') {
    streamSettings.xhttpSettings = {
      path: transportPath || '/',
      host: node.host || node.address,
    };
  }

  let proxyOutbound: Record<string, unknown>;

  if (node.protocol === 'vless') {
    const userObj: Record<string, unknown> = {
      id: node.uuid,
      encryption: node.encryption || 'none',
    };
    if (node.network === 'tcp' && flow) {
      userObj.flow = flow;
    }
    proxyOutbound = {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: outboundConnectAddress,
            port: serverPort,
            users: [userObj],
          },
        ],
      },
      streamSettings,
    };
  } else {
    proxyOutbound = {
      tag: 'proxy',
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: outboundConnectAddress,
            port: serverPort,
            users: [
              {
                id: node.uuid,
                alterId: node.alterId ?? 0,
                security: node.cipher || 'auto',
              },
            ],
          },
        ],
      },
      streamSettings,
    };
  }

  // Multiplexing is optional (off by default): real browsers open 10-30 parallel streams
  // per page and perform faster without mux head-of-line blocking.
  const muxEnabled = Boolean(options.mux) && !flow;
  if (muxEnabled) {
    proxyOutbound.mux = { enabled: true, concurrency: 8, xudpConcurrency: 16, xudpProxyUDP443: 'reject' };
  }

  const tunMode = Boolean(options.tunMode);

  const routingRules: Array<Record<string, unknown>> = [
    {
      type: 'field',
      inboundTag: ['api-in'],
      outboundTag: 'api',
    },
  ];

  if (tunMode) {
    // Every DNS query entering the local inbounds is answered via Xray's DNS module.
    // Restricting to inboundTag prevents Xray's own upstream DNS lookups from looping back into dns-out.
    routingRules.push({
      type: 'field',
      inboundTag: ['socks-in', 'http-in'],
      port: '53',
      outboundTag: 'dns-out',
    });
  }

  routingRules.push({
    // Block QUIC (UDP 443) so browsers immediately use fast TCP HTTP/2 instead of slow UDP-over-TCP
    type: 'field',
    network: 'udp',
    port: '443',
    outboundTag: 'block',
  });

  if (bypassLan) {
    routingRules.push({
      type: 'field',
      ip: [
        '127.0.0.0/8',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '169.254.0.0/16',
        '::1/128',
        'fc00::/7',
        'fe80::/10',
      ],
      outboundTag: 'direct',
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
    type: 'field',
    port: '0-65535',
    outboundTag: splitResult.defaultOutboundTag,
  });

  const useAdguardDns = Boolean(options.adblock?.enabled && options.adblock?.adguardDns);
  const dnsServers = useAdguardDns
    ? ['94.140.14.14', '94.140.15.15', '1.1.1.1']
    : ['1.1.1.1', '8.8.8.8'];

  const logConfig: Record<string, unknown> = {
    loglevel: 'warning',
  };
  if (options.accessLogPath && options.adblock?.enabled) {
    logConfig.access = options.accessLogPath;
  }

  return {
    log: logConfig,
    stats: {},
    api: {
      tag: 'api',
      services: ['StatsService'],
    },
    policy: {
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    dns: {
      servers: dnsServers,
      queryStrategy: 'UseIP',
    },
    inbounds: [
      {
        tag: 'socks-in',
        port: socksPort,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: {
          auth: 'noauth',
          udp: true,
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls'],
          routeOnly: false,
        },
      },
      {
        tag: 'http-in',
        port: httpPort,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: {
          allowTransparent: false,
        },
        // HTTP CONNECT requests from browsers already carry the target hostname;
        // disabling payload sniffing avoids waiting for the TLS ClientHello before dialing.
        sniffing: {
          enabled: false,
        },
      },
      {
        tag: 'api-in',
        port: apiPort,
        listen: '127.0.0.1',
        protocol: 'dokodemo-door',
        settings: {
          address: '127.0.0.1',
        },
      },
    ],
    outbounds: [
      proxyOutbound,
      {
        tag: 'direct',
        protocol: 'freedom',
        settings: {
          domainStrategy: 'UseIP',
        },
        ...(options.physicalInterfaceName
          ? {
              streamSettings: {
                sockopt: {
                  interface: options.physicalInterfaceName,
                },
              },
            }
          : {}),
      },
      {
        tag: 'block',
        protocol: 'blackhole',
        settings: {},
      },
      {
        tag: 'adblock',
        protocol: 'blackhole',
        settings: {},
      },
      ...(tunMode ? [{ tag: 'dns-out', protocol: 'dns', settings: {} }] : []),
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: routingRules,
    },
  };
}
