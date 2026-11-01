import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export function serveAsset(assetsDir: string, pathname: string, res: http.ServerResponse, mimeTypes: Record<string, string>): boolean {
  let filePath: string;
  try {
    const root = fs.realpathSync(assetsDir);
    filePath = fs.realpathSync(path.resolve(root, decodeURIComponent(pathname.slice('/assets/'.length))));
    if (!filePath.startsWith(root + path.sep) || !fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  const stream = fs.createReadStream(filePath);
  stream.once('error', (error: NodeJS.ErrnoException) => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Asset unavailable');
    }
  });
  res.once('close', () => stream.destroy());
  stream.once('open', () => {
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    stream.pipe(res);
  });
  return true;
}
