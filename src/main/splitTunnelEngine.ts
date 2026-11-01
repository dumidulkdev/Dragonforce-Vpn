import type { AdBlockConfig, SplitTunnelConfig, SplitTunnelPresetId } from './types.ts';
import { evaluateDomainShield } from './adblockEngine.ts';
import net from 'node:net';

export interface SplitTunnelPresetMeta {
  id: SplitTunnelPresetId;
  title: string;
  subtitle: string;
  domains: string[];
  sampleHosts: string[];
}

export const SPLIT_TUNNEL_PRESETS: Record<SplitTunnelPresetId, SplitTunnelPresetMeta> = {
  sri_lanka_local: {
    id: 'sri_lanka_local',
    title: 'Sri Lanka & Local Banking (.lk)',
    subtitle: 'Commercial Bank, Sampath, HNB, BOC, Dialog, SLT, Mobitel, Gov.lk & all .lk domains',
    domains: [
      'domain:lk',
      'domain:combank.lk',
      'domain:sampath.lk',
      'domain:hnb.net',
      'domain:hnb.lk',
      'domain:boc.lk',
      'domain:peoplesbank.lk',
      'domain:ndbbank.com',
      'domain:seylan.lk',
      'domain:frimi.lk',
      'domain:dialog.lk',
      'domain:slt.lk',
      'domain:mobitel.lk',
      'domain:daraz.lk',
      'domain:ikman.lk',
      'domain:pickme.lk',
    ],
    sampleHosts: ['combank.lk', 'sampath.lk', 'dialog.lk', 'gov.lk', 'daraz.lk'],
  },
  gaming: {
    id: 'gaming',
    title: 'Gaming & Game Launchers',
    subtitle: 'Steam, Epic Games, Riot Games (Valorant/LoL), Battle.net, EA, Xbox Live & PSN',
    domains: [
      'domain:steampowered.com',
      'domain:steamcommunity.com',
      'domain:steamstatic.com',
      'domain:steamserver.net',
      'domain:steamcontent.com',
      'domain:epicgames.com',
      'domain:unrealengine.com',
      'domain:riotgames.com',
      'domain:leagueoflegends.com',
      'domain:playvalorant.com',
      'domain:battle.net',
      'domain:blizzard.com',
      'domain:ea.com',
      'domain:origin.com',
      'domain:xboxlive.com',
      'domain:playstation.com',
      'domain:playstation.net',
    ],
    sampleHosts: ['steampowered.com', 'epicgames.com', 'riotgames.com', 'battle.net', 'xboxlive.com'],
  },
  streaming: {
    id: 'streaming',
    title: 'Streaming & Media Platforms',
    subtitle: 'Netflix, Disney+, Amazon Prime Video, Spotify, Twitch & Apple TV+',
    domains: [
      'domain:netflix.com',
      'domain:nflxvideo.net',
      'domain:nflximg.net',
      'domain:nflxso.net',
      'domain:disneyplus.com',
      'domain:bamgrid.com',
      'domain:primevideo.com',
      'domain:aiv-cdn.net',
      'domain:spotify.com',
      'domain:scdn.co',
      'domain:twitch.tv',
      'domain:ttvnw.net',
      'domain:jtvnw.net',
      'domain:tv.apple.com',
    ],
    sampleHosts: ['netflix.com', 'disneyplus.com', 'primevideo.com', 'spotify.com', 'twitch.tv'],
  },
  messaging: {
    id: 'messaging',
    title: 'Messaging, Voice & Video Calls',
    subtitle: 'WhatsApp, Telegram, Discord, Zoom, Microsoft Teams & Signal',
    domains: [
      'domain:whatsapp.com',
      'domain:whatsapp.net',
      'domain:wa.me',
      'domain:telegram.org',
      'domain:t.me',
      'domain:tdesktop.com',
      'domain:discord.com',
      'domain:discordapp.com',
      'domain:discordapp.net',
      'domain:discord.gg',
      'domain:discord.media',
      'domain:zoom.us',
      'domain:zoomgov.com',
      'domain:teams.microsoft.com',
      'domain:signal.org',
    ],
    sampleHosts: ['whatsapp.com', 'telegram.org', 'discord.com', 'zoom.us', 'signal.org'],
  },
  ai_cloud: {
    id: 'ai_cloud',
    title: 'AI & Developer Cloud',
    subtitle: 'ChatGPT (OpenAI), Claude (Anthropic), Google Gemini, Perplexity & GitHub',
    domains: [
      'domain:openai.com',
      'domain:chatgpt.com',
      'domain:oaistatic.com',
      'domain:oaiusercontent.com',
      'domain:anthropic.com',
      'domain:claude.ai',
      'domain:gemini.google.com',
      'domain:perplexity.ai',
      'domain:github.com',
      'domain:githubusercontent.com',
      'domain:githubassets.com',
    ],
    sampleHosts: ['chatgpt.com', 'openai.com', 'claude.ai', 'gemini.google.com', 'github.com'],
  },
  windows_updates: {
    id: 'windows_updates',
    title: 'Windows Update & System CDNs',
    subtitle: 'Microsoft Update, Delivery Optimization & Windows Store background downloads',
    domains: [
      'domain:windowsupdate.com',
      'domain:update.microsoft.com',
      'domain:delivery.mp.microsoft.com',
      'domain:dl.delivery.mp.microsoft.com',
      'domain:windowsupdate.microsoft.com',
      'domain:download.windowsupdate.com',
    ],
    sampleHosts: ['windowsupdate.com', 'update.microsoft.com', 'delivery.mp.microsoft.com'],
  },
};

export const PRESET_IDS = Object.keys(SPLIT_TUNNEL_PRESETS) as SplitTunnelPresetId[];

export function defaultSplitTunnelConfig(): SplitTunnelConfig {
  return {
    mode: 'off',
    presets: {
      sri_lanka_local: true,
      gaming: true,
      streaming: false,
      messaging: false,
      ai_cloud: false,
      windows_updates: true,
    },
    customDomains: [],
    customIps: [],
  };
}

export function ensureSplitTunnelConfig(raw?: Partial<SplitTunnelConfig> | null): SplitTunnelConfig {
  const def = defaultSplitTunnelConfig();
  if (!raw || typeof raw !== 'object') return def;

  const mode = raw.mode === 'bypass' || raw.mode === 'vpn_only' || raw.mode === 'off' ? raw.mode : 'off';
  const presets = { ...def.presets };
  if (raw.presets && typeof raw.presets === 'object') {
    for (const id of PRESET_IDS) {
      if (typeof raw.presets[id] === 'boolean') {
        presets[id] = raw.presets[id];
      }
    }
  }

  const customDomains = Array.isArray(raw.customDomains)
    ? Array.from(new Set(raw.customDomains.map(sanitizeDomainEntry).filter(Boolean)))
    : [];
  const customIps = Array.isArray(raw.customIps)
    ? Array.from(new Set(raw.customIps.map(sanitizeIpEntry).filter(Boolean)))
    : [];

  return {
    mode,
    presets,
    customDomains,
    customIps,
  };
}

export function sanitizeIpEntry(input: string): string {
  const s = String(input || '').trim();
  const [address, prefix, ...extra] = s.split('/');
  const family = net.isIP(address);
  if (!family || extra.length || address.includes('%')) return '';
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) return '';
    return `${address.toLowerCase()}/${Number(prefix)}`;
  }
  return address.toLowerCase();
}

export function sanitizeDomainEntry(input: string): string {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//i, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  if (!s || s.includes(' ') || sanitizeIpEntry(s)) return '';
  if (s.length > 253 || /^[\d.]+$/.test(s) || s.split('.').some(label =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) return '';
  return s;
}

/**
 * Auto-classifies user input as either a domain/TLD or an IP/CIDR range.
 */
export function parseSplitTargetInput(raw: string): { kind: 'domain' | 'ip'; value: string } | null {
  const ip = sanitizeIpEntry(raw);
  if (ip) return { kind: 'ip', value: ip };
  const domain = sanitizeDomainEntry(raw);
  if (domain) return { kind: 'domain', value: domain };
  return null;
}

/**
 * Builds Xray-core routing rules for Smart Split Tunneling.
 *
 * - In `bypass` mode: selected domains & IPs route to `direct`, while the final catch-all routes to `proxy`.
 * - In `vpn_only` mode: selected domains & IPs route to `proxy`, while the final catch-all routes to `direct`.
 */
export function buildSplitTunnelRoutingRules(config?: SplitTunnelConfig | null): {
  rules: Array<Record<string, unknown>>;
  defaultOutboundTag: 'proxy' | 'direct';
} {
  if (!config || config.mode === 'off') {
    return { rules: [], defaultOutboundTag: 'proxy' };
  }

  const targetOutbound = config.mode === 'bypass' ? 'direct' : 'proxy';
  const defaultOutboundTag = config.mode === 'bypass' ? 'proxy' : 'direct';

  const domainRules = new Set<string>();
  const ipRules = new Set<string>();

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

  const rules: Array<Record<string, unknown>> = [];
  if (domainRules.size > 0) {
    rules.push({
      type: 'field',
      domain: Array.from(domainRules),
      outboundTag: targetOutbound,
    });
  }
  if (ipRules.size > 0) {
    rules.push({
      type: 'field',
      ip: Array.from(ipRules),
      outboundTag: targetOutbound,
    });
  }

  return { rules, defaultOutboundTag };
}

function ipMatchesCidr(ip: string, cidrOrIp: string): boolean {
  if (!sanitizeIpEntry(cidrOrIp)) return false;
  const [network, prefix] = cidrOrIp.split('/');
  const family = net.isIP(ip);
  if (!family || net.isIP(network) !== family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const list = new net.BlockList();
  list.addSubnet(network, prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix), type);
  return list.check(ip, type);
}

function isPrivateLanIp(ip: string): boolean {
  return (
    ipMatchesCidr(ip, '127.0.0.0/8') ||
    ipMatchesCidr(ip, '10.0.0.0/8') ||
    ipMatchesCidr(ip, '172.16.0.0/12') ||
    ipMatchesCidr(ip, '192.168.0.0/16') ||
    ipMatchesCidr(ip, '169.254.0.0/16') ||
    ipMatchesCidr(ip, '::1/128') ||
    ipMatchesCidr(ip, 'fc00::/7') ||
    ipMatchesCidr(ip, 'fe80::/10')
  );
}

/**
 * Evaluates how Xray-core will route a given domain or IP address under the current
 * Split Tunneling + Ad Shield + LAN Bypass configuration.
 */
export function evaluateSplitTunnelRoute(
  rawTarget: string,
  splitConfig?: SplitTunnelConfig | null,
  adblockConfig?: AdBlockConfig | null,
  bypassLan = true
): {
  target: string;
  outbound: 'proxy' | 'direct' | 'adblock';
  routeLabel: string;
  matchedSource: string;
  matchedRule: string;
} {
  const parsed = parseSplitTargetInput(rawTarget);
  const cfg = ensureSplitTunnelConfig(splitConfig);
  if (!parsed) {
    return {
      target: String(rawTarget || '').trim(),
      outbound: cfg.mode === 'vpn_only' ? 'direct' : 'proxy',
      routeLabel: cfg.mode === 'vpn_only' ? 'Direct ISP' : 'Encrypted VPN Tunnel',
      matchedSource: 'Default Policy',
      matchedRule: 'Invalid or empty target',
    };
  }

  // 1. Check Private LAN IP if bypassLan is enabled
  if (parsed.kind === 'ip' && bypassLan && isPrivateLanIp(parsed.value.split('/')[0])) {
    return {
      target: parsed.value,
      outbound: 'direct',
      routeLabel: 'Direct Local Network (LAN)',
      matchedSource: 'Bypass Local Networks',
      matchedRule: 'Private RFC1918 / Loopback IP',
    };
  }

  // 2. Check Ad Shield if target is a domain
  if (parsed.kind === 'domain' && adblockConfig?.enabled) {
    const shieldCheck = evaluateDomainShield(parsed.value, adblockConfig);
    if (shieldCheck.blocked) {
      return {
        target: parsed.value,
        outbound: 'adblock',
        routeLabel: 'Blocked by Privacy & Ad Shield',
        matchedSource: `Ad Shield (${shieldCheck.category || 'filter'})`,
        matchedRule: shieldCheck.reason,
      };
    }
  }

  // 3. If Split Tunneling is OFF, everything goes through VPN
  if (cfg.mode === 'off') {
    return {
      target: parsed.value,
      outbound: 'proxy',
      routeLabel: 'Encrypted VPN Tunnel',
      matchedSource: 'Split Tunneling Off (Full Tunnel)',
      matchedRule: 'outboundTag: "proxy"',
    };
  }

  const matchedOutbound: 'direct' | 'proxy' = cfg.mode === 'bypass' ? 'direct' : 'proxy';
  const matchedLabel =
    matchedOutbound === 'direct' ? 'Direct ISP (Bypasses VPN)' : 'Encrypted VPN Tunnel (VPN-Only Match)';
  const fallbackOutbound: 'direct' | 'proxy' = cfg.mode === 'bypass' ? 'proxy' : 'direct';
  const fallbackLabel =
    fallbackOutbound === 'proxy' ? 'Encrypted VPN Tunnel (Default)' : 'Direct ISP (Outside VPN-Only List)';

  if (parsed.kind === 'domain') {
    const host = parsed.value;
    // Check Custom Domains first
    for (const customDom of cfg.customDomains) {
      if (host === customDom || host.endsWith(`.${customDom}`)) {
        return {
          target: host,
          outbound: matchedOutbound,
          routeLabel: matchedLabel,
          matchedSource: 'Custom Website Rule',
          matchedRule: `domain:${customDom} -> ${matchedOutbound}`,
        };
      }
    }

    // Check Presets
    for (const id of PRESET_IDS) {
      if (!cfg.presets[id]) continue;
      const preset = SPLIT_TUNNEL_PRESETS[id];
      for (const rule of preset.domains) {
        const suffix = rule.replace(/^domain:/, '');
        if (host === suffix || host.endsWith(`.${suffix}`)) {
          return {
            target: host,
            outbound: matchedOutbound,
            routeLabel: matchedLabel,
            matchedSource: `Preset: ${preset.title}`,
            matchedRule: `${rule} -> ${matchedOutbound}`,
          };
        }
      }
    }
  } else {
    const ipOnly = parsed.value.split('/')[0];
    for (const customIp of cfg.customIps) {
      if (customIp === parsed.value || ipMatchesCidr(ipOnly, customIp)) {
        return {
          target: parsed.value,
          outbound: matchedOutbound,
          routeLabel: matchedLabel,
          matchedSource: 'Custom IP / Subnet Rule',
          matchedRule: `ip:${customIp} -> ${matchedOutbound}`,
        };
      }
    }
  }

  return {
    target: parsed.value,
    outbound: fallbackOutbound,
    routeLabel: fallbackLabel,
    matchedSource: cfg.mode === 'bypass' ? 'All Other Traffic → VPN' : 'All Unlisted Traffic → Direct ISP',
    matchedRule: `outboundTag: "${fallbackOutbound}"`,
  };
}
