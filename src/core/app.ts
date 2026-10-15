import {spawn} from 'node:child_process';
import {existsSync, openSync} from 'node:fs';
import {readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {ensureStateDir, loadProject, readJson, writeJson, type Project} from './project.js';
import {scanLocation} from './scan.js';
import {serveStatic} from './static-server.js';

export interface AppState {
  pid: number | null;
  url: string;
  command: string | null;
  cwd: string;
  startedAt: string;
  log: string | null;
}

const statePath = (project: Project) => path.join(project.stateDir, 'app.json');

export async function readAppState(project: Project): Promise<AppState | null> {
  return readJson<AppState | null>(statePath(project), null);
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(2500)});
    return response.status < 500;
  } catch {
    return false;
  }
}

const URL_IN_LOG = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s"'\u001b]*)/;

async function waitForApp(logFile: string, candidates: string[], pid: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      const tail = existsSync(logFile) ? (await readFile(logFile, 'utf8')).slice(-2000) : '';
      throw new StudioError(`The app process exited before it was reachable.\n${tail}`, 'Check the log, fix the dev command, or pass --command.');
    }
    const log = existsSync(logFile) ? (await readFile(logFile, 'utf8')).replace(/\u001b\[[0-9;]*m/g, '') : '';
    const fromLog = URL_IN_LOG.exec(log)?.[1]?.replace('0.0.0.0', 'localhost');
    const urls = fromLog ? [fromLog, ...candidates] : candidates;
    for (const url of urls) {
      if (await isReachable(url)) return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new StudioError(`App did not become reachable within ${Math.round(timeoutMs / 1000)}s.`, 'Pass --url if it runs on an unusual port, or --command to override the dev command.');
}

export interface StartAppOptions {
  command?: string;
  url?: string;
  cwd?: string;
  static?: boolean;
  timeoutMs?: number;
}

export async function startApp(options: StartAppOptions = {}): Promise<Outcome<AppState>> {
  const project = await loadProject();
  const existing = await readAppState(project);
  if (existing && (isAlive(existing.pid) || !existing.pid) && (await isReachable(existing.url))) {
    return outcome(existing, `App already running at ${existing.url}`, ['gif-studio explore', 'gif-studio browse screenshot /']);
  }

  const knownUrl = options.url ?? project.config.app.url;
  if (knownUrl && !options.command && (await isReachable(knownUrl))) {
    const state: AppState = {pid: null, url: knownUrl, command: null, cwd: project.root, startedAt: new Date().toISOString(), log: null};
    await writeJson(statePath(project), state);
    return outcome(state, `Using running app at ${knownUrl}`, ['gif-studio explore']);
  }

  const cwd = path.resolve(project.root, options.cwd ?? project.config.app.cwd ?? '.');
  const stateDir = await ensureStateDir(project);
  const logFile = path.join(stateDir, 'app.log');

  if (options.static) {
    const pid = await startStaticDaemon(cwd, logFile);
    const url = await waitForApp(logFile, [], pid, options.timeoutMs ?? 20_000);
    const state: AppState = {pid, url, command: 'static', cwd, startedAt: new Date().toISOString(), log: logFile};
    await writeJson(statePath(project), state);
    return outcome(state, `Static server running at ${url}`, ['gif-studio explore']);
  }

  const inventory = await scanLocation(cwd);
  const command = options.command ?? project.config.app.command ?? inventory.app?.devCommand;
  if (!command) {
    throw new StudioError('No dev command found for this location.', 'Pass --command "<cmd>", --url <running app>, or --static to serve the folder.');
  }
  const port = inventory.app?.port;
  const candidates = [knownUrl, port ? `http://localhost:${port}` : null].filter((u): u is string => Boolean(u));

  const out = openSync(logFile, 'w');
  const child = spawn(command, {cwd, shell: true, detached: true, stdio: ['ignore', out, out], env: {...process.env, BROWSER: 'none', FORCE_COLOR: '0'}});
  child.unref();
  const pid = child.pid!;
  const url = await waitForApp(logFile, candidates, pid, options.timeoutMs ?? 180_000);
  const state: AppState = {pid, url, command, cwd, startedAt: new Date().toISOString(), log: logFile};
  await writeJson(statePath(project), state);
  return outcome(state, `App running at ${url} (pid ${pid}, log .gif-studio/app.log)`, [
    'gif-studio browse screenshot /',
    'gif-studio explore',
    'gif-studio auth login <url>  # only if pages redirect to a login',
  ]);
}

async function startStaticDaemon(cwd: string, logFile: string): Promise<number> {
  const out = openSync(logFile, 'w');
  const entry = fileURLToPath(new URL('./static-daemon.js', import.meta.url));
  const child = spawn(process.execPath, [entry, cwd], {detached: true, stdio: ['ignore', out, out]});
  child.unref();
  return child.pid!;
}

export async function stopApp(): Promise<Outcome<{stopped: boolean}>> {
  const project = await loadProject();
  const state = await readAppState(project);
  if (!state) return outcome({stopped: false}, 'No app recorded as running.');
  if (state.pid && isAlive(state.pid)) {
    try {
      process.kill(-state.pid, 'SIGTERM');
    } catch {
      process.kill(state.pid, 'SIGTERM');
    }
  }
  await rm(statePath(project), {force: true});
  return outcome({stopped: true}, `Stopped app${state.pid ? ` (pid ${state.pid})` : ''}.`);
}

export async function appStatus(): Promise<Outcome<(AppState & {reachable: boolean}) | null>> {
  const project = await loadProject();
  const state = await readAppState(project);
  if (!state) return outcome(null, 'No app running.', ['gif-studio app start']);
  const reachable = await isReachable(state.url);
  return outcome({...state, reachable}, `${state.url} ${reachable ? 'reachable' : 'NOT reachable'}`, reachable ? [] : ['gif-studio app start']);
}

export async function resolveAppUrl(project: Project, target: string): Promise<string> {
  if (/^https?:\/\//.test(target)) return target;
  const state = await readAppState(project);
  const base = state?.url ?? project.config.app.url;
  if (!base) throw new StudioError(`Cannot resolve "${target}" without a running app.`, 'Run gif-studio app start, or pass a full URL.');
  return new URL(target, base.endsWith('/') ? base : `${base}/`).toString();
}

export async function listenOnFreePort(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind server');
  return {server, url: `http://127.0.0.1:${address.port}`};
}

export {serveStatic};
