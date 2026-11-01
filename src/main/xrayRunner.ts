import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { promisify } from 'node:util';
import { generateXrayConfig, type XrayConfigOptions } from './xrayConfig.ts';
import type { ServerNode } from './types.ts';
import { XRAY_API_PORT } from './networkSettings.ts';
import { stopChildProcess } from './childProcess.ts';
import { nativeBinaryNames, resolveNativeBinaries } from './binaries.ts';

const execFileAsync = promisify(execFile);

export class XrayRunner {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private binDir: string;
  private configPath: string;
  private xrayPath: string | null = null;
  private xrayEnv: NodeJS.ProcessEnv | undefined;
  private apiPort = XRAY_API_PORT;
  private onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private onUnexpectedExit: (code: number | null) => void;

  constructor(
    binDir: string,
    configDir: string,
    onLog: (level: 'info' | 'warn' | 'error', msg: string) => void,
    onUnexpectedExit: (code: number | null) => void
  ) {
    this.binDir = binDir;
    this.configPath = path.join(configDir, 'active-config.json');
    this.onLog = onLog;
    this.onUnexpectedExit = onUnexpectedExit;
  }

  public isRunning(): boolean {
    return this.proc !== null;
  }

  public async start(node: ServerNode, options: XrayConfigOptions = {}): Promise<void> {
    await this.stop();

    const binaries = resolveNativeBinaries({ bundledBinDir: this.binDir });
    const xrayExe = binaries.xrayPath;
    if (!xrayExe) {
      const expected = nativeBinaryNames().xray;
      throw new Error(`${expected} was not found or is not executable. Configure DRAGONFORCE_XRAY_PATH or install the native binary.`);
    }
    this.xrayPath = xrayExe;
    this.xrayEnv = process.platform === 'linux' && binaries.xrayAssetDir
      ? { ...process.env, XRAY_LOCATION_ASSET: binaries.xrayAssetDir }
      : undefined;

    this.apiPort = options.apiPort ?? XRAY_API_PORT;
    const configObj = generateXrayConfig(node, options);
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(configObj, null, 2), 'utf-8');

    this.onLog(
      'info',
      `Starting Xray-core for [${node.protocol.toUpperCase()}] ${node.name} (${node.address}:${node.port}, net=${node.network}, sec=${node.security})`
    );

    const proc = spawn(xrayExe, ['run', '-c', this.configPath], {
      cwd: path.dirname(xrayExe),
      env: this.xrayEnv,
      windowsHide: true,
    });
    this.proc = proc;

    let startupError = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf-8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        // Xray reports config errors on stdout as "Failed to start: … > reason"
        if (line.startsWith('Failed to start')) startupError += `${line}\n`;
        const level =
          line.includes('[Error]') || line.includes('failed') || line.startsWith('Failed')
            ? 'error'
            : line.includes('[Warning]')
              ? 'warn'
              : 'info';
        this.onLog(level, line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      startupError += text;
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.onLog('error', line);
      }
    });

    proc.on('exit', (code) => {
      const wasRunning = this.proc === proc;
      if (wasRunning) {
        this.proc = null;
        this.onLog('warn', `Xray-core process exited with code ${code ?? 0}`);
        this.onUnexpectedExit(code);
      }
    });
    proc.on('error', (error) => {
      startupError += error.message;
      if (this.proc === proc) {
        this.proc = null;
        this.onLog('error', `Xray-core process error: ${error.message}`);
        this.onUnexpectedExit(null);
      }
    });

    // Wait 700ms to confirm Xray didn't immediately crash on config validation or port conflict
    await new Promise((r) => setTimeout(r, 700));
    if (this.proc !== proc || proc.killed) {
      // Keep the most specific part of Xray's "a > b > c" error chain.
      const reason = startupError.trim().split(' > ').pop()?.trim();
      throw new Error(
        `Xray-core failed to start: ${reason || 'Check logs for port conflict or invalid server config.'}`
      );
    }
  }

  public async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try {
      await stopChildProcess(p);
    } catch (error) {
      // Retain ownership so cleanup can be retried rather than orphaning the process.
      if (p.exitCode === null && p.signalCode === null) this.proc = p;
      throw error;
    }
  }

  /**
   * Queries Xray StatsService for cumulative outbound proxy uplink & downlink bytes
   */
  public async queryTrafficStats(): Promise<{ upBytes: number; downBytes: number } | null> {
    if (!this.proc) return null;
    const xrayExe = this.xrayPath;
    if (!xrayExe) return null;

    try {
      const { stdout } = await execFileAsync(
        xrayExe,
        ['api', 'statsquery', `--server=127.0.0.1:${this.apiPort}`],
        { timeout: 2000, windowsHide: true, env: this.xrayEnv }
      );

      let upBytes = 0;
      let downBytes = 0;

      try {
        const parsed = JSON.parse(stdout) as {
          stat?: Array<{ name?: string; value?: number | string }>;
        };
        if (Array.isArray(parsed.stat)) {
          for (const item of parsed.stat) {
            const name = item.name || '';
            const val = Number(item.value || 0);
            if (!Number.isFinite(val)) continue;
            if (name === 'outbound>>>proxy>>>traffic>>>uplink') {
              upBytes = val;
            } else if (name === 'outbound>>>proxy>>>traffic>>>downlink') {
              downBytes = val;
            }
          }
          return { upBytes, downBytes };
        }
      } catch {
        // Fallback regex if output is proto text
        const upMatch = stdout.match(
          /outbound>>>proxy>>>traffic>>>uplink"[\s\S]*?value:\s*(\d+)/
        );
        const downMatch = stdout.match(
          /outbound>>>proxy>>>traffic>>>downlink"[\s\S]*?value:\s*(\d+)/
        );
        if (upMatch) upBytes = Number(upMatch[1]);
        if (downMatch) downBytes = Number(downMatch[1]);
      }

      return { upBytes, downBytes };
    } catch {
      return null;
    }
  }
}

/**
 * Performs a real end-to-end HTTP 204 request through the local Xray HTTP inbound proxy
 * (`127.0.0.1:httpPort`) to verify the VLESS/VMess + TLS tunnel works and measure true latency.
 */
export function testProxyConnectivity(
  httpPort: number,
  timeoutMs = 7000
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: httpPort,
        method: 'GET',
        path: 'http://cp.cloudflare.com/generate_204',
        headers: {
          Host: 'cp.cloudflare.com',
          'User-Agent': 'Xray-VPN-Client/1.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const latencyMs = Math.max(1, Math.round(performance.now() - start));
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ ok: true, latencyMs });
        } else {
          resolve({
            ok: false,
            latencyMs: -1,
            error: `Unexpected status HTTP ${res.statusCode}`,
          });
        }
      }
    );

    req.once('timeout', () => {
      req.destroy();
      resolve({ ok: false, latencyMs: -1, error: 'Proxy test timed out' });
    });

    req.once('error', (err) => {
      resolve({ ok: false, latencyMs: -1, error: err.message });
    });

    req.end();
  });
}
