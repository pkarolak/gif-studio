import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, openSync} from 'node:fs';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {watch} from 'chokidar';
import {WebSocketServer, type WebSocket} from 'ws';
import {isReachable} from '../core/app.js';
import {
  assetDir,
  assetSummary,
  listAssetNames,
  listVersions,
  readNotes,
  readPacing,
  requireAsset,
  withStatus,
  writeNotes,
  writePacing,
  type Note,
} from '../core/assets.js';
import {outcome, StudioError, type Outcome} from '../core/outcome.js';
import {ensureStateDir, loadProject, packageRoot, readJson, slugify, writeJson, type Project} from '../core/project.js';
import {renderAsset, type RenderFormat} from '../core/render.js';
import {sendFile} from '../core/static-server.js';
import {createFileHandler} from './files.js';

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = (await body(req)).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}

export interface StudioServer {
  url: string;
  close(): Promise<void>;
}

export async function startStudioServer(options: {port?: number; host?: string} = {}): Promise<StudioServer> {
  const project = await loadProject();
  const files = createFileHandler(project);
  const uiDir = path.join(packageRoot(), 'dist', 'studio');
  const sockets = new Set<WebSocket>();
  const broadcast = (message: unknown) => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(payload);
  };
  let rendering: string | null = null;

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const method = req.method ?? 'GET';

    if (parts[0] === 'project' && method === 'GET') {
      const names = await listAssetNames(project);
      return reply(res, 200, {root: project.root, assetsDir: project.config.assetsDir, rendering, assets: await Promise.all(names.map((n) => assetSummary(project, n)))});
    }
    if (parts[0] !== 'assets' || !parts[1]) return reply(res, 404, {error: 'Unknown endpoint'});
    const name = parts[1];
    await requireAsset(project, name);
    const resource = parts[2];

    if (!resource && method === 'GET') {
      const versions = await listVersions(project, name);
      const notes = withStatus(await readNotes(project, name), versions.map((v) => v.n));
      return reply(res, 200, {asset: name, versions, notes, pacing: await readPacing(project, name), rendering});
    }
    if (resource === 'notes') {
      const notes = await readNotes(project, name);
      if (method === 'POST') {
        const input = await json<Partial<Note>>(req);
        const note: Note = {
          id: randomUUID().slice(0, 8),
          version: input.version ?? 0,
          t: Math.round(input.t ?? 0),
          x: input.x ?? 0.5,
          y: input.y ?? 0.5,
          text: input.text ?? '',
          attachments: input.attachments ?? [],
          done: false,
          createdAt: new Date().toISOString(),
        };
        notes.push(note);
        await writeNotes(project, name, notes);
        return reply(res, 201, note);
      }
      const id = parts[3];
      const index = notes.findIndex((n) => n.id === id);
      if (index < 0) return reply(res, 404, {error: 'Note not found'});
      if (method === 'PATCH') {
        const patch = await json<Partial<Note>>(req);
        notes[index] = {...notes[index]!, ...patch, id: notes[index]!.id};
        await writeNotes(project, name, notes);
        return reply(res, 200, notes[index]);
      }
      if (method === 'DELETE') {
        notes.splice(index, 1);
        await writeNotes(project, name, notes);
        return reply(res, 204, null);
      }
    }
    if (resource === 'attachments' && method === 'POST') {
      const original = url.searchParams.get('name') ?? 'image.png';
      const ext = path.extname(original) || '.png';
      const file = `notes-attachments/${Date.now()}-${slugify(path.basename(original, ext))}${ext}`;
      const target = path.join(assetDir(project, name), file);
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, await body(req));
      return reply(res, 201, {path: file});
    }
    if (resource === 'pacing' && method === 'PUT') {
      const {speeds} = await json<{speeds: Record<string, number>}>(req);
      const clean = Object.fromEntries(Object.entries(speeds ?? {}).filter(([, v]) => typeof v === 'number' && v > 0 && v !== 1));
      await writePacing(project, name, clean);
      return reply(res, 200, {speeds: clean});
    }
    if (resource === 'render' && method === 'POST') {
      if (rendering) return reply(res, 409, {error: `Already rendering ${rendering}`});
      const input = await json<{version?: string | null; formats?: RenderFormat[]}>(req);
      rendering = name;
      reply(res, 202, {started: true});
      renderAsset(name, {
        version: input.version ?? undefined,
        formats: input.formats,
        onProgress: (progress) => broadcast({type: 'render-progress', asset: name, progress}),
      })
        .then((result) => broadcast({type: 'render-done', asset: name, result: result.data}))
        .catch((error: Error) => broadcast({type: 'render-error', asset: name, error: error.message}))
        .finally(() => {
          rendering = null;
        });
      return;
    }
    return reply(res, 404, {error: 'Unknown endpoint'});
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (files(req, res)) return;
      const file = path.join(uiDir, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file.startsWith(uiDir) && sendFile(res, file, req)) return;
      if (sendFile(res, path.join(uiDir, 'index.html'), req)) return;
      res.writeHead(500).end('Studio UI missing: run npm run build in gif-studio.');
    } catch (error) {
      const err = error as StudioError;
      reply(res, err instanceof StudioError ? 400 : 500, {error: err.message, hint: err.hint});
    }
  });

  const wss = new WebSocketServer({server, path: '/ws'});
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await mkdir(project.assetsDir, {recursive: true});
  const watcher = watch(project.assetsDir, {
    ignoreInitial: true,
    ignored: (file) => /[\\/](versions|archive|final|node_modules)[\\/]/.test(file),
    awaitWriteFinish: {stabilityThreshold: 120, pollInterval: 40},
  });
  watcher.on('all', (_event, file) => {
    const rel = path.relative(project.assetsDir, file).split(path.sep);
    const asset = rel[0];
    if (!asset) return;
    if (asset === 'captures') return broadcast({type: 'scene-changed', asset: null, file: rel.join('/')});
    const leaf = rel.slice(1).join('/');
    if (leaf === 'notes.json') return broadcast({type: 'notes-changed', asset});
    if (leaf === 'pacing.json') return broadcast({type: 'pacing-changed', asset});
    if (leaf.startsWith('notes-attachments')) return;
    broadcast({type: 'scene-changed', asset, file: leaf});
  });

  const port = options.port ?? project.config.studioPort;
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  const url = `http://localhost:${actualPort}`;
  await writeJson(path.join(await ensureStateDir(project), 'studio.json'), {url, pid: process.pid});

  return {
    url,
    close: async () => {
      await watcher.close();
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(path.join(project.stateDir, 'studio.json'), {force: true});
    },
  };
}

export async function ensureStudioRunning(project?: Project, options: {port?: number} = {}): Promise<Outcome<{url: string; started: boolean}>> {
  const p = project ?? (await loadProject());
  const state = await readJson<{url?: string} | null>(path.join(p.stateDir, 'studio.json'), null);
  if (state?.url && (await isReachable(`${state.url}/api/project`))) {
    return outcome({url: state.url, started: false}, `Studio already running at ${state.url}`, ['Ask the user to open it, scrub, and leave notes']);
  }
  const stateDir = await ensureStateDir(p);
  const log = openSync(path.join(stateDir, 'studio.log'), 'w');
  const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  const args = [cli, 'studio', '--no-open', ...(options.port ? ['--port', String(options.port)] : [])];
  const child = spawn(process.execPath, args, {cwd: p.root, detached: true, stdio: ['ignore', log, log], env: {...process.env, GIF_STUDIO_ROOT: p.root}});
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const fresh = await readJson<{url?: string} | null>(path.join(p.stateDir, 'studio.json'), null);
    if (fresh?.url && (await isReachable(`${fresh.url}/api/project`))) {
      return outcome({url: fresh.url, started: true}, `Studio running at ${fresh.url}`, ['Tell the user to open the URL, pick a version, click the frame to leave notes, then say "apply notes from vN"']);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!existsSync(path.join(p.stateDir, 'studio.log'))) throw new StudioError('Studio failed to start.');
  throw new StudioError('Studio failed to start within 15s.', 'See .gif-studio/studio.log');
}
