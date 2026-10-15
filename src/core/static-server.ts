import {createReadStream, existsSync, statSync} from 'node:fs';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json',
};

export function sendFile(res: ServerResponse, file: string, req?: IncomingMessage): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const size = statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req?.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store'});
    createReadStream(file, {start, end}).pipe(res);
    return true;
  }
  res.writeHead(200, {'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'});
  createReadStream(file).pipe(res);
  return true;
}

export function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]!);
  const full = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export function serveStatic(root: string) {
  const base = path.resolve(root);
  return (req: IncomingMessage, res: ServerResponse) => {
    let file = safeJoin(base, req.url ?? '/');
    if (!file) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!sendFile(res, file, req)) {
      const fallback = path.join(base, 'index.html');
      if (!sendFile(res, fallback, req)) res.writeHead(404).end('Not found');
    }
  };
}
