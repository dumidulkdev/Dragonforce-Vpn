import { hostnameToAscii, ipFamily } from './netUtils.ts';

/** Accept DNS hostnames and complete IP literals, never URLs or malformed IPs. */
export function normalizeServerAddress(input: string): string {
  let address = input.trim();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
    if (ipFamily(address) !== 6) throw new Error('Enter a valid server address');
  }
  if (ipFamily(address) && !address.includes('%')) return address.toLowerCase();
  if (!address || /[\s/:?#@%\[\]\\]/.test(address) || /^[\d.]+$/.test(address)) {
    throw new Error('Enter a valid server address');
  }
  const hostname = hostnameToAscii(address).toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) throw new Error('Enter a valid server address');
  return hostname;
}

export function parseServerPort(input: unknown): number {
  if ((typeof input !== 'number' && typeof input !== 'string') ||
      (typeof input === 'string' && !/^\d{1,5}$/.test(input))) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}
