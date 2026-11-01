import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const ENV_KEY = 'HKCU\\Environment';
type RegistryValue = { kind: 'String' | 'ExpandString' | 'DWord' | 'QWord'; value: string | number };
type RegistrySnapshot = Record<string, RegistryValue | null>;
let proxySnapshot: RegistrySnapshot | null = null;
let terminalSnapshot: RegistrySnapshot | null = null;
let pendingChange: Promise<unknown> = Promise.resolve();

function changeRegistry<T>(change: () => Promise<T>): Promise<T> {
  const result = pendingChange.then(change);
  pendingChange = result.catch(() => undefined);
  return result;
}

async function snapshotValues(key: string, names: string[]): Promise<RegistrySnapshot> {
  const script = `
    $ErrorActionPreference = 'Stop'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key.slice(5)}')
    $values = @{}
    foreach ($name in @(${names.map(name => `'${name}'`).join(',')})) {
      if ($key -and ($key.GetValueNames() -icontains $name)) {
        $values[$name] = @{
          kind = $key.GetValueKind($name).ToString()
          value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
      } else { $values[$name] = $null }
    }
    if ($key) { $key.Dispose() }
    ConvertTo-Json -InputObject $values -Compress
  `;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const snapshot = JSON.parse(stdout.trim()) as RegistrySnapshot;
  for (const name of names) {
    if (!(name in snapshot) || (snapshot[name] && !['String', 'ExpandString', 'DWord', 'QWord'].includes(snapshot[name]!.kind))) {
      throw new Error(`Cannot preserve existing registry value ${name}`);
    }
  }
  return snapshot;
}

async function restoreValues(key: string, snapshot: RegistrySnapshot): Promise<void> {
  const types = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD' };
  for (const [name, original] of Object.entries(snapshot)) {
    if (original) {
      await execFileAsync('reg.exe', ['add', key, '/v', name, '/t', types[original.kind], '/d', String(original.value), '/f']);
    } else {
      try {
        await execFileAsync('reg.exe', ['delete', key, '/v', name, '/f']);
      } catch (error) {
        // A previously absent value may already have been removed. Other failures must surface.
        if ((await snapshotValues(key, [name]))[name] !== null) throw error;
      }
    }
  }
}

async function notifyEnvironmentChanged(): Promise<void> {
  try {
    const script = `
      $sig = '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
      $type = Add-Type -MemberDefinition $sig -Name EnvironmentNotify -Namespace DragonForce -PassThru
      $result = [UIntPtr]::Zero
      [void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result)
    `;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  } catch { /* Existing shells retain their inherited environment until reopened. */ }
}

const BYPASS_LIST =
  'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>';

async function notifyWinInetProxyChanged(): Promise<void> {
  try {
    const ps = `
      $sig = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int lpdwBufferLength);'
      $type = Add-Type -MemberDefinition $sig -Name WinInet -Namespace PInvoke -PassThru
      [void]$type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
      [void]$type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
    `;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
    });
  } catch {
    // Non-fatal if PowerShell notification fails
  }
}

export async function enableWindowsSystemProxy(httpPort: number): Promise<void> {
  return changeRegistry(async () => {
    proxySnapshot ??= await snapshotValues(REG_KEY, ['AutoDetect', 'ProxyEnable', 'ProxyServer', 'ProxyOverride']);
    try {
      const proxyServer = `127.0.0.1:${httpPort}`;
      await execFileAsync('reg.exe', [
        'add',
        REG_KEY,
        '/v',
        'AutoDetect',
        '/t',
        'REG_DWORD',
        '/d',
        '0',
        '/f',
      ]);
      await execFileAsync('reg.exe', [
        'add',
        REG_KEY,
        '/v',
        'ProxyEnable',
        '/t',
        'REG_DWORD',
        '/d',
        '1',
        '/f',
      ]);
      await execFileAsync('reg.exe', [
        'add',
        REG_KEY,
        '/v',
        'ProxyServer',
        '/t',
        'REG_SZ',
        '/d',
        proxyServer,
        '/f',
      ]);
      await execFileAsync('reg.exe', [
        'add',
        REG_KEY,
        '/v',
        'ProxyOverride',
        '/t',
        'REG_SZ',
        '/d',
        BYPASS_LIST,
        '/f',
      ]);
      await notifyWinInetProxyChanged();
    } catch (error) {
      await restoreValues(REG_KEY, proxySnapshot);
      proxySnapshot = null;
      await notifyWinInetProxyChanged();
      throw error;
    }
  });
}

export async function disableWindowsSystemProxy(): Promise<void> {
  return changeRegistry(async () => {
    if (!proxySnapshot) return;
    await restoreValues(REG_KEY, proxySnapshot);
    proxySnapshot = null;
    await notifyWinInetProxyChanged();
  });
}

/**
 * Sets or restores user-level HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY environment variables
 * so terminal tools (npm, pip, curl, git, cargo) work even without Admin TUN mode.
 */
export async function setWindowsTerminalProxyEnv(
  enabled: boolean,
  httpPort: number,
  socksPort: number
): Promise<void> {
  return changeRegistry(async () => {
    if (enabled) {
      terminalSnapshot ??= await snapshotValues(ENV_KEY, ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
      try {
        const httpUrl = `http://127.0.0.1:${httpPort}`;
        const socksUrl = `socks5://127.0.0.1:${socksPort}`;
        for (const varName of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
          await execFileAsync('reg.exe', [
            'add',
            ENV_KEY,
            '/v',
            varName,
            '/t',
            'REG_SZ',
            '/d',
            httpUrl,
            '/f',
          ]);
        }
        for (const varName of ['ALL_PROXY', 'all_proxy']) {
          await execFileAsync('reg.exe', [
            'add',
            ENV_KEY,
            '/v',
            varName,
            '/t',
            'REG_SZ',
            '/d',
            socksUrl,
            '/f',
          ]);
        }
        for (const varName of ['NO_PROXY', 'no_proxy']) {
          await execFileAsync('reg.exe', [
            'add',
            ENV_KEY,
            '/v',
            varName,
            '/t',
            'REG_SZ',
            '/d',
            'localhost,127.0.0.1,::1',
            '/f',
          ]);
        }
      } catch (error) {
        await restoreValues(ENV_KEY, terminalSnapshot);
        terminalSnapshot = null;
        await notifyEnvironmentChanged();
        throw error;
      }
    } else {
      if (!terminalSnapshot) return;
      await restoreValues(ENV_KEY, terminalSnapshot);
      terminalSnapshot = null;
    }
    await notifyEnvironmentChanged();
  });
}

export interface ProxyOperationResult {
  applied: boolean;
  message?: string;
}

function unsupportedPlatform(feature: string): Error {
  return new Error(`${feature} is not supported on ${process.platform}.`);
}

export async function enableSystemProxy(httpPort: number): Promise<ProxyOperationResult> {
  if (process.platform === 'win32') {
    await enableWindowsSystemProxy(httpPort);
    return { applied: true };
  }
  if (process.platform === 'linux') {
    const message = `Local Proxy mode is active. Configure an HTTP proxy at 127.0.0.1:${httpPort} or use the SOCKS5 port shown in Settings. Desktop-wide proxy integration is pending.`;
    console.log(message);
    return { applied: false, message };
  }
  throw unsupportedPlatform('System proxy integration');
}

export async function disableSystemProxy(): Promise<ProxyOperationResult> {
  if (process.platform === 'win32') {
    await disableWindowsSystemProxy();
    return { applied: false };
  }
  if (process.platform === 'linux') return { applied: false };
  throw unsupportedPlatform('System proxy integration');
}

export async function enableTerminalProxy(httpPort: number, socksPort: number): Promise<ProxyOperationResult> {
  if (process.platform === 'win32') {
    await setWindowsTerminalProxyEnv(true, httpPort, socksPort);
    return { applied: true };
  }
  if (process.platform === 'linux') {
    const message = `Linux terminal proxy variables were not changed. Configure HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:${httpPort} and ALL_PROXY=socks5://127.0.0.1:${socksPort} in the terminal session that should use the local proxy.`;
    console.log(message);
    return { applied: false, message };
  }
  throw unsupportedPlatform('Terminal proxy integration');
}

export async function disableTerminalProxy(httpPort: number, socksPort: number): Promise<ProxyOperationResult> {
  if (process.platform === 'win32') {
    await setWindowsTerminalProxyEnv(false, httpPort, socksPort);
    return { applied: false };
  }
  if (process.platform === 'linux') {
    return { applied: false, message: 'Linux terminal proxy variables were not changed, so there is nothing to restore.' };
  }
  throw unsupportedPlatform('Terminal proxy integration');
}

export function getTerminalProxyCommands(httpPort: number, socksPort: number): {
  powershell: string;
  cmd: string;
  git: string;
  npm: string;
} {
  return {
    powershell: `$env:HTTP_PROXY="http://127.0.0.1:${httpPort}"; $env:HTTPS_PROXY="http://127.0.0.1:${httpPort}"; $env:ALL_PROXY="socks5://127.0.0.1:${socksPort}"`,
    cmd: `set HTTP_PROXY=http://127.0.0.1:${httpPort} && set HTTPS_PROXY=http://127.0.0.1:${httpPort} && set ALL_PROXY=socks5://127.0.0.1:${socksPort}`,
    git: `git config --global http.proxy http://127.0.0.1:${httpPort} && git config --global https.proxy http://127.0.0.1:${httpPort}`,
    npm: `npm config set proxy http://127.0.0.1:${httpPort} && npm config set https-proxy http://127.0.0.1:${httpPort}`,
  };
}
