import fs from 'node:fs';
import path from 'node:path';

export interface NativeBinaryNames {
  xray: string;
  tun2socks: string;
  wintun: string | null;
}

export interface NativeBinaries {
  xrayPath: string | null;
  tun2socksPath: string | null;
  wintunPath: string | null;
  geoipPath: string | null;
  geositePath: string | null;
  xrayAssetDir: string | null;
}

export interface ResolveNativeBinariesOptions {
  bundledBinDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  systemBinDirs?: string[];
  systemAssetDirs?: string[];
}

export function nativeBinaryNames(platform: NodeJS.Platform = process.platform): NativeBinaryNames {
  if (platform === 'win32') {
    return { xray: 'xray.exe', tun2socks: 'tun2socks.exe', wintun: 'wintun.dll' };
  }
  if (platform === 'linux') {
    return { xray: 'xray', tun2socks: 'tun2socks', wintun: null };
  }
  return { xray: 'xray', tun2socks: 'tun2socks', wintun: null };
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isExecutableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isRegularFile(file)) return false;
  if (platform !== 'linux') return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstExecutable(candidates: Array<string | undefined>, platform: NodeJS.Platform): string | null {
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    if (visited.has(absolute)) continue;
    visited.add(absolute);
    if (isExecutableFile(absolute, platform)) return absolute;
  }
  return null;
}

function assetDirectory(candidates: Array<string | undefined>): string | null {
  const visited = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    if (visited.has(absolute)) continue;
    visited.add(absolute);
    if (isRegularFile(path.join(absolute, 'geoip.dat')) && isRegularFile(path.join(absolute, 'geosite.dat'))) {
      return absolute;
    }
  }
  return null;
}

export function resolveNativeBinaries(options: ResolveNativeBinariesOptions = {}): NativeBinaries {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const names = nativeBinaryNames(platform);
  const bundledBinDir = path.resolve(options.bundledBinDir || env.VPN_BIN_DIR || path.join('resources', 'bin'));

  if (platform === 'win32') {
    const xrayPath = path.join(bundledBinDir, names.xray);
    const tun2socksPath = path.join(bundledBinDir, names.tun2socks);
    const wintunPath = path.join(bundledBinDir, names.wintun!);
    const xrayAssetDir = assetDirectory([bundledBinDir]);
    return {
      xrayPath: isExecutableFile(xrayPath, platform) ? xrayPath : null,
      tun2socksPath: isExecutableFile(tun2socksPath, platform) ? tun2socksPath : null,
      wintunPath: isRegularFile(wintunPath) ? wintunPath : null,
      geoipPath: xrayAssetDir ? path.join(xrayAssetDir, 'geoip.dat') : null,
      geositePath: xrayAssetDir ? path.join(xrayAssetDir, 'geosite.dat') : null,
      xrayAssetDir,
    };
  }

  if (platform !== 'linux') {
    return {
      xrayPath: null,
      tun2socksPath: null,
      wintunPath: null,
      geoipPath: null,
      geositePath: null,
      xrayAssetDir: null,
    };
  }

  const pathDirectories = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const systemDirectories = [
    ...pathDirectories,
    ...(options.systemBinDirs ?? ['/usr/local/bin', '/usr/bin']),
  ];
  const xrayPath = firstExecutable([
    env.DRAGONFORCE_XRAY_PATH,
    path.join(bundledBinDir, names.xray),
    ...systemDirectories.map(dir => path.join(dir, names.xray)),
  ], platform);
  const tun2socksPath = firstExecutable([
    env.DRAGONFORCE_TUN2SOCKS_PATH,
    path.join(bundledBinDir, names.tun2socks),
    ...systemDirectories.map(dir => path.join(dir, names.tun2socks)),
  ], platform);
  const xrayAssetDir = assetDirectory([
    bundledBinDir,
    env.XRAY_LOCATION_ASSET,
    xrayPath ? path.dirname(xrayPath) : undefined,
    ...(options.systemAssetDirs ?? ['/usr/share/xray', '/usr/share/v2ray']),
  ]);

  return {
    xrayPath,
    tun2socksPath,
    wintunPath: null,
    geoipPath: xrayAssetDir ? path.join(xrayAssetDir, 'geoip.dat') : null,
    geositePath: xrayAssetDir ? path.join(xrayAssetDir, 'geosite.dat') : null,
    xrayAssetDir,
  };
}
