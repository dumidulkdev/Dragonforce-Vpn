import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { stopChildProcess } from './childProcess.ts';
import { resolveNativeBinaries } from './binaries.ts';
import {
  getLinuxTunCapability,
  IP_PATH,
  LINUX_TUN_NAME,
  LinuxNetworkHelperClient,
} from './linuxNetworkHelper.ts';

const execFileAsync = promisify(execFile);

const TUN_NAME = 'XrayTUN';
const TUN_IP = '198.18.0.1';
const TUN_MASK = '255.254.0.0';
const TUN_IPV6 = 'fdfe:dcba:9876::1';

export async function checkIsAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await execFileAsync('net.exe', ['session']);
    return true;
  } catch {
    return false;
  }
}

async function flushDnsCache(): Promise<void> {
  try {
    await execFileAsync('ipconfig.exe', ['/flushdns'], { windowsHide: true });
  } catch {
    // ignore
  }
}

export interface PhysicalRouteInfo {
  gatewayIp: string;
  interfaceName: string;
  interfaceIndex: string;
}

export async function detectPhysicalGateway(family: 4 | 6 = 4, endpoint?: string): Promise<PhysicalRouteInfo> {
  if (process.platform === 'linux') {
    if (family !== 4) throw new Error('Linux TUN MVP supports IPv4 VPN endpoints only');
    const args = endpoint
      ? ['-4', '-json', 'route', 'get', endpoint]
      : ['-4', '-json', 'route', 'show', 'default'];
    const { stdout } = await execFileAsync(IP_PATH, args, { windowsHide: true });
    let routes: Array<{ gateway?: string; dev?: string; type?: string; metric?: number }>;
    try { routes = JSON.parse(stdout); }
    catch { throw new Error('Could not parse the Linux IPv4 route table'); }
    const usable = routes
      .filter(route => (!route.type || route.type === 'unicast') && net.isIPv4(route.gateway || '') &&
        Boolean(route.dev) && route.dev !== LINUX_TUN_NAME)
      .sort((a, b) => Number(a.metric || 0) - Number(b.metric || 0));
    if (usable.length !== 1 && endpoint) throw new Error('The VPN endpoint must resolve to exactly one physical IPv4 route');
    const route = usable[0];
    if (!route?.gateway || !route.dev) throw new Error('Could not detect an IPv4 physical gateway and interface');
    const { stdout: linkJson } = await execFileAsync(IP_PATH, ['-json', 'link', 'show', 'dev', route.dev], { windowsHide: true });
    let links: Array<{ ifindex?: number }>;
    try { links = JSON.parse(linkJson); }
    catch { throw new Error('Could not parse the Linux physical interface'); }
    const interfaceIndex = links[0]?.ifindex;
    if (!Number.isInteger(interfaceIndex) || interfaceIndex! <= 0) throw new Error('Could not identify the Linux physical interface index');
    return { gatewayIp: route.gateway, interfaceName: route.dev, interfaceIndex: String(interfaceIndex) };
  }
  if (process.platform !== 'win32') throw new Error(`TUN routing is not supported on ${process.platform}`);
  const defaultPrefix = family === 4 ? '0.0.0.0/0' : '::/0';
  const psScript = `
    $route = Get-NetRoute -DestinationPrefix '${defaultPrefix}' -ErrorAction SilentlyContinue |
      Where-Object { $_.InterfaceAlias -ne '${TUN_NAME}' -and $_.NextHop -ne '0.0.0.0' -and $_.NextHop -ne '::' } |
      Sort-Object { $_.RouteMetric + $_.InterfaceMetric } |
      Select-Object -First 1;
    if ($route) {
      $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue;
      Write-Output "$($route.NextHop)|$($adapter.Name)|$($route.InterfaceIndex)"
    }
  `;

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    psScript,
  ]);

  const line = stdout.trim().split(/\r?\n/).find(Boolean) || '';
  const [gatewayIp, interfaceName, interfaceIndex] = line.split('|').map((s) => s.trim());

  if (net.isIP(gatewayIp) !== family || !interfaceName || !/^\d+$/.test(interfaceIndex)) {
    throw new Error(`Could not detect active physical IPv${family} adapter and default gateway`);
  }

  return { gatewayIp, interfaceName, interfaceIndex };
}

export async function resolveServerIpv4List(address: string): Promise<string[]> {
  if (net.isIPv4(address)) {
    return [address];
  }
  if (net.isIPv6(address)) {
    return [];
  }
  try {
    const records = await dns.lookup(address, { all: true, family: 4 });
    return Array.from(new Set(records.map((r) => r.address)));
  } catch {
    return [];
  }
}

/** Prefer IPv4 endpoints, but support IPv6-only VPN servers as well. */
export async function resolveServerAddresses(address: string): Promise<string[]> {
  if (net.isIP(address)) return [address];
  try {
    const records = await dns.lookup(address, { all: true });
    const ipv4 = records.filter(record => record.family === 4);
    return [...new Set((ipv4.length ? ipv4 : records).map(record => record.address))];
  } catch {
    return [];
  }
}

async function waitForTunInterfaceIndex(assertRunning: () => void, timeoutMs = 6000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    assertRunning();
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-NetAdapter -Name '${TUN_NAME}' -ErrorAction SilentlyContinue).ifIndex`,
      ]);
      const idx = stdout.trim();
      if (idx && /^\d+$/.test(idx)) {
        return idx;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${TUN_NAME} Wintun adapter to appear`);
}

export class TunManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private addedRoutes: Array<{ prefix: string; gateway: string; index: string }> = [];
  private configured = false;
  private linuxHelper: LinuxNetworkHelperClient | null = null;
  private linuxHelperFailure: string | null = null;
  private onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private onUnexpectedExit: (code: number | null) => void;

  constructor(onLog: (level: 'info' | 'warn' | 'error', msg: string) => void, onUnexpectedExit: (code: number | null) => void = () => {}) {
    this.onLog = onLog;
    this.onUnexpectedExit = onUnexpectedExit;
  }

  public isRunning(): boolean {
    return this.proc !== null && (process.platform !== 'linux' ||
      (this.configured && this.linuxHelper?.isRunning() === true && !this.linuxHelperFailure));
  }

  public async start(
    binDir: string,
    socksPort: number,
    serverAddress: string,
    preResolvedIps?: string[],
    physicalRoute?: PhysicalRouteInfo,
    signal?: AbortSignal
  ): Promise<void> {
    await this.stop();
    signal?.throwIfAborted();

    try {
      if (process.platform === 'win32') {
        await this.startWindows(binDir, socksPort, serverAddress, preResolvedIps, physicalRoute, signal);
      } else if (process.platform === 'linux') {
        await this.startLinux(binDir, socksPort, serverAddress, preResolvedIps, physicalRoute, signal);
      } else {
        throw new Error(`TUN mode is not supported on ${process.platform}`);
      }
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new Error(`${String(error)}; ${String(cleanupError)}`); }
      throw error;
    }
  }

  private async addRoute(prefix: string, gateway: string, index: string, metric: number): Promise<void> {
    if (!/^\d+$/.test(index) || !net.isIP(gateway)) throw new Error('Invalid route gateway or interface');
    const route = { prefix, gateway, index };
    const script = `
      $ErrorActionPreference = 'Stop'
      $existing = Get-NetRoute -DestinationPrefix '${prefix}' -InterfaceIndex ${index} -NextHop '${gateway}' -PolicyStore ActiveStore -ErrorAction SilentlyContinue
      if ($existing) { 'existing' } else {
        New-NetRoute -DestinationPrefix '${prefix}' -InterfaceIndex ${index} -NextHop '${gateway}' -RouteMetric ${metric} -PolicyStore ActiveStore | Out-Null
        'added'
      }
    `;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    if (stdout.trim() === 'added') this.addedRoutes.push(route);
    else if (stdout.trim() !== 'existing') throw new Error(`Could not confirm route ${prefix}`);
  }

  private async startWindows(
    binDir: string,
    socksPort: number,
    serverAddress: string,
    preResolvedIps?: string[],
    physicalRoute?: PhysicalRouteInfo,
    signal?: AbortSignal
  ): Promise<void> {

    const isAdmin = await checkIsAdmin();
    if (!isAdmin) {
      throw new Error(
        'TUN Mode requires Administrator privileges to create the Wintun virtual adapter and configure OS routes. Use "Restart as administrator" in Settings.'
      );
    }

    const tunExe = path.join(binDir, 'tun2socks.exe');
    const wintunDll = path.join(binDir, 'wintun.dll');

    if (!fs.existsSync(tunExe) || !fs.existsSync(wintunDll)) {
      throw new Error(
        `Missing tun2socks.exe or wintun.dll in ${binDir}.`
      );
    }

    const serverIps = preResolvedIps?.length ? preResolvedIps : await resolveServerAddresses(serverAddress);
    if (!serverIps.length || serverIps.some(ip => !net.isIP(ip))) throw new Error('Could not resolve a valid VPN server IP for TUN routing');
    const endpointFamily = net.isIPv6(serverIps[0]) ? 6 : 4;
    const { gatewayIp, interfaceName, interfaceIndex } = physicalRoute || await detectPhysicalGateway(endpointFamily);
    this.onLog(
      'info',
      `Detected physical interface "${interfaceName}" (gateway ${gatewayIp})`
    );

    // Add direct route for VPN server IP(s) via physical gateway to prevent routing loops
    for (const ip of serverIps) {
      signal?.throwIfAborted();
      const family = net.isIPv6(ip) ? 6 : 4;
      const route = family === endpointFamily ? { gatewayIp, interfaceIndex } : await detectPhysicalGateway(family);
      await this.addRoute(`${ip}/${family === 4 ? 32 : 128}`, route.gatewayIp, route.interfaceIndex, 1);
      this.onLog('info', `Using direct bypass route for server IP ${ip} -> ${route.gatewayIp}`);
    }
    signal?.throwIfAborted();

    const args = [
      '--device',
      `tun://${TUN_NAME}`,
      '--proxy',
      `socks5://127.0.0.1:${socksPort}`,
      '--interface',
      interfaceName,
      '--mtu',
      '1420',
      '--tcp-auto-tuning',
      '--tcp-sndbuf',
      '4m',
      '--tcp-rcvbuf',
      '4m',
      '--loglevel',
      'warn',
    ];

    this.onLog('info', `Starting tun2socks: ${args.join(' ')}`);
    let lastErrorLine = '';
    const proc = spawn(tunExe, args, {
      cwd: binDir,
      windowsHide: true,
    });
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf-8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.onLog('info', line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf-8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        lastErrorLine = line;
        this.onLog('warn', line);
      }
    });

    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.onLog('warn', `tun2socks exited with code ${code ?? 0}`);
        this.onUnexpectedExit(code);
      }
    });
    proc.on('error', (error) => {
      lastErrorLine = error.message;
      if (this.proc === proc) {
        this.proc = null;
        this.onLog('error', `tun2socks process error: ${error.message}`);
        this.onUnexpectedExit(null);
      }
    });

    const assertRunning = () => {
      signal?.throwIfAborted();
      if (this.proc !== proc || proc.killed) throw new Error(`tun2socks exited unexpectedly: ${lastErrorLine || 'failed to initialize Wintun'}`);
    };
    const tunIfIndex = await waitForTunInterfaceIndex(assertRunning);
    assertRunning();

    // Configure IP and DNS on XrayTUN adapter
    await execFileAsync('netsh.exe', [
      'interface',
      'ip',
      'set',
      'address',
      `name=${TUN_NAME}`,
      'source=static',
      `addr=${TUN_IP}`,
      `mask=${TUN_MASK}`,
      'gateway=none',
    ]);
    this.configured = true;
    assertRunning();

    // Both IPv6 halves must be captured before reporting TUN as active. A
    // dual-stack network must never retain an unprotected IPv6 default route.
    await execFileAsync('netsh.exe', [
      'interface', 'ipv6', 'set', 'interface', tunIfIndex,
      'dadtransmits=0', 'routerdiscovery=disabled', 'metric=1', 'mtu=1420', 'store=active',
    ]);
    assertRunning();
    await execFileAsync('netsh.exe', [
      'interface', 'ipv6', 'add', 'address', tunIfIndex, `${TUN_IPV6}/64`, 'store=active',
    ]);
    assertRunning();

    try {
      await execFileAsync('netsh.exe', [
        'interface',
        'ip',
        'set',
        'dns',
        `name=${TUN_NAME}`,
        'source=static',
        'addr=1.1.1.1',
        'validate=no',
      ]);
      await execFileAsync('netsh.exe', [
        'interface',
        'ipv4',
        'set',
        'subinterface',
        TUN_NAME,
        'mtu=1420',
        'store=active',
      ]);
    } catch {
      // Non-fatal if DNS or MTU setting warns
    }

    try {
      // Lowest metric => Windows asks the TUN resolver first; Xray answers it locally (FakeDNS).
      await execFileAsync('netsh.exe', ['interface', 'ipv4', 'set', 'interface', TUN_NAME, 'metric=1']);
      await flushDnsCache();
    } catch {
      // Non-fatal: DNS still works through the hijack, just without the preference
    }

    for (const prefix of ['::/1', '8000::/1', '0.0.0.0/1', '128.0.0.0/1']) {
      assertRunning();
      await this.addRoute(prefix, prefix.includes(':') ? '::' : TUN_IP, tunIfIndex, 2);
    }
    assertRunning();

    this.onLog(
      'info',
      `TUN Mode active (${TUN_NAME} [IF ${tunIfIndex}]). IPv4 and IPv6 OS traffic now follows Xray routing rules.`
    );
  }

  private async startLinux(
    binDir: string,
    socksPort: number,
    serverAddress: string,
    preResolvedIps?: string[],
    physicalRoute?: PhysicalRouteInfo,
    signal?: AbortSignal
  ): Promise<void> {
    const capability = getLinuxTunCapability();
    if (!capability.available) {
      throw new Error(capability.reason || 'Linux TUN mode requires the DragonForce network helper to be installed by the package manager.');
    }
    const binaries = resolveNativeBinaries({ bundledBinDir: binDir });
    if (!binaries.tun2socksPath) {
      throw new Error('tun2socks was not found or is not executable. Configure DRAGONFORCE_TUN2SOCKS_PATH or install tun2socks.');
    }
    const resolved = preResolvedIps?.length ? preResolvedIps : await resolveServerAddresses(serverAddress);
    const serverIps = resolved.filter(net.isIPv4);
    if (!serverIps.length || serverIps.length !== resolved.length) {
      throw new Error('Linux TUN MVP requires an IPv4 VPN server endpoint.');
    }
    const endpoint = serverIps[0];
    const route = physicalRoute || await detectPhysicalGateway(4, endpoint);
    if (!net.isIPv4(route.gatewayIp) || !interfacePattern(route.interfaceName)) {
      throw new Error('Invalid Linux physical gateway or interface');
    }
    signal?.throwIfAborted();
    await this.assertNoLinuxIpv6Default();
    await this.waitForLocalSocks(socksPort, signal);

    const helper = new LinuxNetworkHelperClient(
      this.onLog,
      code => {
        this.linuxHelperFailure = `Linux network helper exited (${code ?? 'unknown'})`;
        this.onUnexpectedExit(code);
      }
    );
    this.linuxHelper = helper;
    this.linuxHelperFailure = null;
    await helper.start();
    signal?.throwIfAborted();
    const sessionId = helper.newSessionId();
    await helper.prepare(sessionId, endpoint, route.gatewayIp, route.interfaceName);
    signal?.throwIfAborted();

    const args = [
      '--device', LINUX_TUN_NAME,
      '--proxy', `socks5://127.0.0.1:${socksPort}`,
      '--interface', route.interfaceName,
      '--tcp-auto-tuning',
      '--tcp-sndbuf', '4m',
      '--tcp-rcvbuf', '4m',
      '--loglevel', 'warn',
    ];
    this.onLog('info', `Starting Linux tun2socks: ${args.join(' ')}`);
    let lastErrorLine = '';
    const proc = spawn(binaries.tun2socksPath, args, {
      cwd: path.dirname(binaries.tun2socksPath),
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/).filter(Boolean)) this.onLog('info', line);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/).filter(Boolean)) {
        lastErrorLine = line;
        this.onLog('warn', line);
      }
    });
    proc.on('exit', code => {
      if (this.proc === proc) {
        this.proc = null;
        this.configured = false;
        this.onLog('warn', `tun2socks exited with code ${code ?? 0}`);
        this.onUnexpectedExit(code);
      }
    });
    proc.on('error', error => {
      lastErrorLine = error.message;
      if (this.proc === proc) {
        this.proc = null;
        this.configured = false;
        this.onLog('error', `tun2socks process error: ${error.message}`);
        this.onUnexpectedExit(null);
      }
    });
    await new Promise(resolve => setTimeout(resolve, 700));
    signal?.throwIfAborted();
    if (this.proc !== proc || proc.killed) {
      throw new Error(`tun2socks failed to initialize the Linux TUN device: ${lastErrorLine || 'process exited'}`);
    }
    await helper.activate();
    signal?.throwIfAborted();
    if (!helper.isRunning() || this.linuxHelperFailure) {
      throw new Error(this.linuxHelperFailure || 'Linux network helper stopped during activation');
    }
    this.configured = true;
    this.onLog('info', `Linux IPv4 TUN active (${LINUX_TUN_NAME}). IPv6-default hosts are refused to prevent leaks.`);
  }

  private async assertNoLinuxIpv6Default(): Promise<void> {
    const { stdout } = await execFileAsync(IP_PATH, ['-6', '-json', 'route', 'show', 'default'], { windowsHide: true });
    let routes: unknown[];
    try { routes = JSON.parse(stdout); }
    catch { throw new Error('Could not parse the Linux IPv6 route table'); }
    if (routes.length > 0) {
      throw new Error('Linux IPv4-only TUN mode was refused because an active IPv6 default route could leak traffic.');
    }
  }

  private async waitForLocalSocks(port: number, signal?: AbortSignal, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const ready = await new Promise<boolean>(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(300, () => finish(false));
      });
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Xray SOCKS5 inbound 127.0.0.1:${port} did not become ready`);
  }

  public async stop(): Promise<void> {
    if (process.platform === 'linux') return this.stopLinux();
    return this.stopWindows();
  }

  private async stopWindows(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    const errors: unknown[] = [];
    if (proc) {
      try { await stopChildProcess(proc); }
      catch (error) {
        if (proc.exitCode === null && proc.signalCode === null) this.proc = proc;
        errors.push(error);
      }
    }
    for (const route of [...this.addedRoutes].reverse()) {
      try {
        const script = `
          $ErrorActionPreference = 'Stop'
          $existing = Get-NetRoute -DestinationPrefix '${route.prefix}' -InterfaceIndex ${route.index} -NextHop '${route.gateway}' -PolicyStore ActiveStore -ErrorAction SilentlyContinue
          if ($existing) { $existing | Remove-NetRoute -Confirm:$false -ErrorAction Stop }
          exit 0
        `;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        this.addedRoutes.splice(this.addedRoutes.indexOf(route), 1);
      } catch (error) {
        errors.push(error);
      }
    }

    if (proc || this.configured) {
      // Drop VPN DNS answers cached by Windows on both normal and unexpected exits.
      await flushDnsCache();
      this.configured = false;
    }
    if (errors.length) throw new Error(`TUN cleanup failed: ${errors.map(String).join('; ')}`);
  }

  private async stopLinux(): Promise<void> {
    let helper = this.linuxHelper;
    const proc = this.proc;
    this.proc = null;
    const errors: unknown[] = [];
    if (proc) {
      try { await stopChildProcess(proc); }
      catch (error) {
        if (proc.exitCode === null && proc.signalCode === null) this.proc = proc;
        errors.push(error);
      }
    }
    // Keep capture policy in place if tun2socks could not be stopped; removing
    // it here would fail open to the physical default route.
    if (errors.length) throw new Error(`Linux TUN cleanup failed: ${errors.map(String).join('; ')}`);
    if (helper && !helper.isRunning()) {
      const recovery = new LinuxNetworkHelperClient(this.onLog);
      try {
        // Startup reconciles the root-owned stale journal before reporting ready.
        await recovery.start();
        helper = recovery;
        this.linuxHelper = recovery;
      } catch (error) {
        errors.push(new Error(`Could not restart the Linux network helper for cleanup: ${String(error)}`));
      }
    }
    if (!helper?.isRunning() && this.configured && errors.length === 0) {
      errors.push(new Error('Linux network helper exited before route cleanup; restart the connection to reconcile its journal.'));
    }
    if (helper?.isRunning()) {
      try {
        await helper.cleanup();
        this.linuxHelper = null;
        this.linuxHelperFailure = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) this.configured = false;
    if (errors.length) throw new Error(`Linux TUN cleanup failed: ${errors.map(String).join('; ')}`);
  }
}

function interfacePattern(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/.test(value) && value !== LINUX_TUN_NAME;
}
