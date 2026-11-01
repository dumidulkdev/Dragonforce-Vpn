import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'build/icon.ico');
await fs.mkdir(path.dirname(destination), { recursive: true });
const source = path.join(root, 'public/assets/logo.png').replace(/'/g, "''");
const script = `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Drawing
  $source = [System.Drawing.Image]::FromFile('${source}')
  $bitmap = New-Object System.Drawing.Bitmap 256,256
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, 256, 256)
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
  $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $source.Dispose()
`;
const { stdout } = await promisify(execFile)('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
], { windowsHide: true });
const png = Buffer.from(stdout.trim(), 'base64');
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await fs.writeFile(destination, Buffer.concat([header, png]));
console.log('[release] Generated Windows icon from the app logo');
