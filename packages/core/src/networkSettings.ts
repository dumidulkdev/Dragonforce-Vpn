import type { PersistedData } from './types.ts';

export const XRAY_API_PORT = 10085;
export type NetworkSettings = Pick<PersistedData, 'socksPort' | 'httpPort' | 'bypassLan' | 'allowInsecureDefault' | 'muxEnabled'>;

export function getNetworkSettings(data: PersistedData): NetworkSettings {
  return {
    socksPort: data.socksPort, httpPort: data.httpPort, bypassLan: data.bypassLan,
    allowInsecureDefault: data.allowInsecureDefault, muxEnabled: Boolean(data.muxEnabled),
  };
}

export function validateNetworkSettings(current: PersistedData, patch: Record<string, unknown>, uiPort?: number): NetworkSettings {
  const next = getNetworkSettings(current);
  for (const field of ['socksPort', 'httpPort'] as const) {
    const value = patch[field] === undefined ? next[field] : patch[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1025 || value > 65535) {
      throw new Error(`${field === 'socksPort' ? 'SOCKS' : 'HTTP'} port must be an integer between 1025 and 65535`);
    }
    next[field] = value;
    if (next[field] === XRAY_API_PORT || next[field] === uiPort) throw new Error(`Port ${next[field]} is reserved by the VPN controller`);
  }
  if (next.socksPort === next.httpPort) throw new Error('SOCKS and HTTP ports must be different');
  for (const field of ['bypassLan', 'allowInsecureDefault', 'muxEnabled'] as const) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== 'boolean') throw new Error(`${field} must be true or false`);
    next[field] = patch[field];
  }
  return next;
}
