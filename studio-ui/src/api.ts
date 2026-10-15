import type {SceneBeat, SceneSection} from '../../src/shared/pacing';

export interface AssetSummary {
  asset: string;
  versions: Array<{label: string; archived: boolean; durationMs: number | null; outputs: string[]}>;
  latest: string | null;
  openNotes: number;
  final: boolean;
}

export interface ProjectInfo {
  root: string;
  assetsDir: string;
  rendering: string | null;
  assets: AssetSummary[];
}

export interface Version {
  n: number;
  label: string;
  dir: string;
  archived: boolean;
  durationMs: number | null;
  createdAt: string | null;
  outputs: Array<{format: string; file: string; bytes: number}>;
}

export interface Note {
  id: string;
  version: number;
  t: number;
  x: number;
  y: number;
  text: string;
  attachments: string[];
  done: boolean;
  createdAt: string;
  coveredIn: number | null;
  open: boolean;
}

export interface AssetDetail {
  asset: string;
  versions: Version[];
  notes: Note[];
  pacing: Record<string, number>;
  rendering: string | null;
}

export interface Manifest {
  width: number;
  height: number;
  duration: number;
  sections: SceneSection[];
  beats: SceneBeat[];
}

export interface RenderProgress {
  phase: string;
  done: number;
  total: number;
}

export type ServerEvent =
  | {type: 'render-progress'; asset: string; progress: RenderProgress}
  | {type: 'render-done'; asset: string; result: {version: string}}
  | {type: 'render-error'; asset: string; error: string}
  | {type: 'scene-changed'; asset: string | null; file: string}
  | {type: 'notes-changed'; asset: string}
  | {type: 'pacing-changed'; asset: string};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as {error?: string}).error ?? `Request failed (${res.status})`);
  return body as T;
}

const jsonInit = (method: string, value: unknown): RequestInit => ({
  method,
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(value),
});

const assetUrl = (asset: string, rest = '') => `/api/assets/${encodeURIComponent(asset)}${rest}`;

export const api = {
  project: () => request<ProjectInfo>('/api/project'),
  asset: (asset: string) => request<AssetDetail>(assetUrl(asset)),
  addNote: (asset: string, note: Pick<Note, 'version' | 't' | 'x' | 'y' | 'text' | 'attachments'>) => request<Note>(assetUrl(asset, '/notes'), jsonInit('POST', note)),
  updateNote: (asset: string, id: string, patch: Partial<Note>) => request<Note>(assetUrl(asset, `/notes/${id}`), jsonInit('PATCH', patch)),
  deleteNote: (asset: string, id: string) => request<void>(assetUrl(asset, `/notes/${id}`), {method: 'DELETE'}),
  upload: (asset: string, file: File) =>
    request<{path: string}>(assetUrl(asset, `/attachments?name=${encodeURIComponent(file.name || 'pasted.png')}`), {method: 'POST', body: file}),
  setPacing: (asset: string, speeds: Record<string, number>) => request<{speeds: Record<string, number>}>(assetUrl(asset, '/pacing'), jsonInit('PUT', {speeds})),
  render: (asset: string, formats: string[]) => request<{started: boolean}>(assetUrl(asset, '/render'), jsonInit('POST', {formats})),
};

export function filesUrl(assetsDir: string, projectRelative: string): string {
  const prefix = `${assetsDir.replace(/\/$/, '')}/`;
  const rest = projectRelative.startsWith(prefix) ? projectRelative.slice(prefix.length) : projectRelative;
  return `/files/${rest.split('/').map(encodeURIComponent).join('/')}`;
}

export function sceneUrl(asset: string, version: Version | null): string {
  const base = `/files/${encodeURIComponent(asset)}/`;
  if (!version) return `${base}scene.html`;
  return `${base}${version.archived ? 'archive' : 'versions'}/${version.label}/scene.html`;
}

export function subscribe(onEvent: (event: ServerEvent) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as ServerEvent);
    socket.onclose = () => {
      if (!closed) retry = setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}

export function formatTime(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
