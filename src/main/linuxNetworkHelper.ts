import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';

export const LINUX_NETWORK_HELPER = '/usr/lib/dragonforce-vpn/dragonforce-net-helper';
export const PKEXEC_PATH = '/usr/bin/pkexec';
export const IP_PATH = '/usr/bin/ip';
export const TUN_DEVICE_PATH = '/dev/net/tun';
export const LINUX_TUN_NAME = 'dfvpn0';

export interface LinuxTunCapability {
  supported: boolean;
  available: boolean;
  privilegeMode: 'polkit' | 'unsupported';
  reason: string | null;
}

export interface LinuxTunCapabilityOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  pkexecPath?: string;
  ipPath?: string;
  tunDevicePath?: string;
}

function executable(file: string): boolean {
  try {
    return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

function tunDeviceAvailable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    return stat.isCharacterDevice();
  } catch {
    return false;
  }
}

export function getLinuxTunCapability(options: LinuxTunCapabilityOptions = {}): LinuxTunCapability {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return { supported: false, available: false, privilegeMode: 'unsupported', reason: 'Linux TUN is only available on Linux.' };
  }
  const helperPath = options.helperPath ?? LINUX_NETWORK_HELPER;
  const required = [options.pkexecPath ?? PKEXEC_PATH, options.ipPath ?? IP_PATH];
  for (const file of required) {
    if (!executable(file)) {
      return { supported: true, available: false, privilegeMode: 'polkit', reason: `Required Linux networking component is unavailable: ${file}` };
    }
  }
  const tunDevicePath = options.tunDevicePath ?? TUN_DEVICE_PATH;
  if (!tunDeviceAvailable(tunDevicePath)) {
    return { supported: true, available: false, privilegeMode: 'polkit', reason: `Linux TUN device is unavailable: ${tunDevicePath}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(helperPath);
  } catch {
    return {
      supported: true,
      available: false,
      privilegeMode: 'polkit',
      reason: 'Linux TUN mode requires the DragonForce network helper to be installed by the package manager.',
    };
  }
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || !executable(helperPath)) {
    return {
      supported: true,
      available: false,
      privilegeMode: 'polkit',
      reason: 'The DragonForce network helper must be executable, root-owned, and not writable by group or other users.',
    };
  }
  return { supported: true, available: true, privilegeMode: 'polkit', reason: null };
}

interface HelperResponse {
  action: string;
  ok: boolean;
  error?: string;
}

interface PendingResponse {
  action: string;
  resolve: (value: HelperResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LinuxNetworkHelperClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private output = '';
  private pending: PendingResponse[] = [];
  private stderr = '';
  private expectedExit = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private readonly onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly onUnexpectedExit: (code: number | null) => void;

  constructor(
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void,
    onUnexpectedExit: (code: number | null) => void = () => {}
  ) {
    this.onLog = onLog;
    this.onUnexpectedExit = onUnexpectedExit;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const capability = getLinuxTunCapability();
    if (!capability.available) throw new Error(capability.reason || 'Linux TUN helper is unavailable.');
    const proc = spawn(PKEXEC_PATH, [LINUX_NETWORK_HELPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    this.output = '';
    this.stderr = '';
    this.expectedExit = false;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    proc.stdout.on('data', chunk => this.consume(String(chunk)));
    proc.stderr.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-8000);
      this.onLog('warn', String(chunk).trim());
    });
    proc.on('error', error => {
      if (this.proc === proc) {
        this.proc = null;
        this.failAll(error);
      }
    });
    proc.on('exit', code => {
      const owned = this.proc === proc;
      if (owned) this.proc = null;
      this.resolveExit?.();
      this.resolveExit = null;
      if (owned) this.failAll(new Error(`Linux network helper exited (${code ?? 'unknown'}): ${this.stderr.trim()}`));
      if (owned && !this.expectedExit) this.onUnexpectedExit(code);
    });
    const ready = await this.waitFor('ready', 60000);
    if (!ready.ok) {
      this.expectedExit = true;
      proc.stdin.end();
      throw new Error(ready.error || 'Linux network helper could not initialize.');
    }
  }

  newSessionId(): string {
    return crypto.randomUUID();
  }

  async prepare(sessionId: string, endpoint: string, gateway: string, interfaceName: string): Promise<void> {
    await this.request({ action: 'prepare', sessionId, endpoint, gateway, interface: interfaceName });
  }

  async activate(): Promise<void> {
    await this.request({ action: 'activate' });
  }

  async deactivate(): Promise<void> {
    if (!this.proc) return;
    await this.request({ action: 'deactivate' });
  }

  async cleanup(): Promise<void> {
    if (!this.proc) return;
    this.expectedExit = true;
    try {
      await this.request({ action: 'cleanup' });
      const exitPromise = this.exitPromise;
      if (exitPromise) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Linux network helper did not exit after cleanup.')), 5000);
          exitPromise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
        });
      }
    } catch (error) {
      this.expectedExit = false;
      throw error;
    }
  }

  terminate(): void {
    const proc = this.proc;
    this.expectedExit = true;
    this.proc = null;
    proc?.stdin.end();
    if (proc?.exitCode === null) proc?.kill();
  }

  private async request(payload: Record<string, unknown>): Promise<void> {
    const proc = this.proc;
    if (!proc) throw new Error('Linux network helper is not running.');
    const action = String(payload.action || 'invalid');
    const response = this.waitFor(action, 30000);
    proc.stdin.write(JSON.stringify(payload) + '\n', error => {
      if (error) this.failAll(error);
    });
    const result = await response;
    if (!result.ok) throw new Error(result.error || `Linux network helper ${action} failed.`);
  }

  private waitFor(action: string, timeoutMs: number): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter(item => item.timer !== timer);
        reject(new Error(`Timed out waiting for Linux network helper ${action}.`));
      }, timeoutMs);
      this.pending.push({ action, resolve, reject, timer });
    });
  }

  private consume(chunk: string): void {
    this.output += chunk;
    for (;;) {
      const end = this.output.indexOf('\n');
      if (end < 0) break;
      const line = this.output.slice(0, end).trim();
      this.output = this.output.slice(end + 1);
      if (!line) continue;
      let response: HelperResponse;
      try {
        response = JSON.parse(line) as HelperResponse;
      } catch {
        this.failAll(new Error('Linux network helper returned invalid JSON.'));
        continue;
      }
      const index = this.pending.findIndex(item => item.action === response.action);
      if (index < 0) {
        this.onLog('warn', `Unexpected Linux network helper response: ${line}`);
        continue;
      }
      const [pending] = this.pending.splice(index, 1);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private failAll(error: Error): void {
    const pending = this.pending.splice(0);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}
