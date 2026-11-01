import { execFile } from 'node:child_process';

/**
 * Windows native bridge for reading QR images/text from the OS clipboard
 * (e.g. after Win+Shift+S Snipping Tool) and capturing the desktop screen
 * for instant QR scanning.
 */

function runPowerShellSta(script: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 25 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        resolve((stdout || '').trim());
      }
    );
  });
}

export interface ClipboardQrPayload {
  ok: boolean;
  kind?: 'image' | 'text' | 'empty';
  dataUrl?: string;
  text?: string;
  error?: string;
}

/**
 * Reads either a bitmap image (converted to PNG data URL) or text from the
 * Windows system clipboard.
 */
export async function readWindowsClipboard(): Promise<ClipboardQrPayload> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -ne $img) {
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()
    $img.Dispose()
    Write-Output ("IMG:" + $b64)
    exit 0
  }
}
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $txt = [System.Windows.Forms.Clipboard]::GetText()
  if ($txt) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($txt)
    Write-Output ("TXT:" + [Convert]::ToBase64String($bytes))
    exit 0
  }
}
Write-Output "EMPTY"
`;
  try {
    const out = await runPowerShellSta(script);
    if (out.startsWith('IMG:')) {
      return {
        ok: true,
        kind: 'image',
        dataUrl: `data:image/png;base64,${out.slice(4).trim()}`,
      };
    }
    if (out.startsWith('TXT:')) {
      const text = Buffer.from(out.slice(4).trim(), 'base64').toString('utf-8');
      return {
        ok: true,
        kind: 'text',
        text,
      };
    }
    return { ok: true, kind: 'empty' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ScreenCapturePayload {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Captures the virtual desktop screen into a PNG data URL.
 */
export async function captureWindowsScreen(delayMs = 0): Promise<ScreenCapturePayload> {
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(2000, delayMs)));
  }
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$b64 = [Convert]::ToBase64String($ms.ToArray())
$g.Dispose()
$bmp.Dispose()
$ms.Dispose()
Write-Output ("SCREEN:" + $b.Width + ":" + $b.Height + ":" + $b64)
`;
  try {
    const out = await runPowerShellSta(script, 8000);
    const idx = out.indexOf('SCREEN:');
    if (idx === -1) {
      return { ok: false, error: 'Desktop screen capture unavailable in current session' };
    }
    const parts = out.slice(idx + 7).split(':');
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    const b64 = parts.slice(2).join(':').trim();
    if (!b64 || b64.length < 100) {
      return { ok: false, error: 'Empty screen capture buffer' };
    }
    return {
      ok: true,
      width,
      height,
      dataUrl: `data:image/png;base64,${b64}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
