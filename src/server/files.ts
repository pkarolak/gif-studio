import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {packageRoot, type Project} from '../core/project.js';
import {safeJoin, sendFile} from '../core/static-server.js';

export function runtimeFile(): string {
  return path.join(packageRoot(), 'dist', 'runtime', 'index.js');
}

export function createFileHandler(project: Project) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__studio/runtime.js') {
      if (sendFile(res, runtimeFile(), req)) return true;
      res.writeHead(500).end('runtime missing: build gif-studio first');
      return true;
    }
    if (url.pathname.startsWith('/files/')) {
      const file = safeJoin(project.assetsDir, url.pathname.slice('/files'.length));
      if (file && sendFile(res, file, req)) return true;
      res.writeHead(404).end('Not found');
      return true;
    }
    return false;
  };
}
