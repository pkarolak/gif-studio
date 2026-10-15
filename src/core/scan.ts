import {existsSync} from 'node:fs';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {readDimensions, type Dimensions} from './media.js';
import {outcome, type Outcome} from './outcome.js';
import {loadProject, writeJson, type Project} from './project.js';

export type LocationKind = 'app' | 'static-site' | 'asset-folder' | 'docs' | 'mixed' | 'empty';

export interface MediaFile extends Partial<Dimensions> {
  path: string;
  bytes: number;
}

export interface AppSignals {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  framework: string | null;
  devCommand: string | null;
  port: number | null;
  routes: string[];
  storybook: boolean;
}

export interface Inventory {
  root: string;
  scannedAt: string;
  kind: LocationKind;
  name: string | null;
  pitch: string | null;
  app: AppSignals | null;
  brand: {
    colors: Array<{value: string; count: number; name?: string}>;
    cssVariables: Array<{name: string; value: string}>;
    fonts: string[];
    tokenFiles: string[];
    tailwindConfig: string | null;
    logos: string[];
  };
  content: {
    images: MediaFile[];
    videos: MediaFile[];
    screenshots: string[];
    docs: string[];
  };
  seedAccounts: Array<{source: string; email?: string; username?: string; password?: string}>;
  counts: {files: number; images: number; videos: number; docs: number; code: number};
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.gif-studio',
  'target',
  '.idea',
  '.vscode',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.pdf', '.rst']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less']);
const MAX_FILES = 20000;
const MAX_TEXT_BYTES = 400_000;

const FRAMEWORKS: Array<{dep: string; name: string; port: number}> = [
  {dep: 'next', name: 'next', port: 3000},
  {dep: '@remix-run/dev', name: 'remix', port: 5173},
  {dep: '@react-router/dev', name: 'react-router', port: 5173},
  {dep: 'nuxt', name: 'nuxt', port: 3000},
  {dep: '@sveltejs/kit', name: 'sveltekit', port: 5173},
  {dep: 'astro', name: 'astro', port: 4321},
  {dep: '@angular/core', name: 'angular', port: 4200},
  {dep: 'react-scripts', name: 'create-react-app', port: 3000},
  {dep: 'gatsby', name: 'gatsby', port: 8000},
  {dep: 'vite', name: 'vite', port: 5173},
  {dep: 'webpack-dev-server', name: 'webpack', port: 8080},
  {dep: 'express', name: 'express', port: 3000},
];

export async function walk(root: string, limit = MAX_FILES): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.storybook' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        files.push(full);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

async function readText(file: string): Promise<string> {
  try {
    const info = await stat(file);
    if (info.size > MAX_TEXT_BYTES) return '';
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function detectPackageManager(root: string): AppSignals['packageManager'] {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  if (existsSync(path.join(root, 'package.json'))) return 'npm';
  return null;
}

function portFromScript(script: string | undefined): number | null {
  if (!script) return null;
  const match = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/.exec(script);
  return match ? Number(match[1]) : null;
}

export function detectRoutes(root: string, files: string[], sources: Map<string, string>): string[] {
  const routes = new Set<string>();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    let route: string | null = null;
    let m: RegExpExecArray | null;
    if ((m = /^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(rel)) || /^(?:src\/)?app\/page\.(?:tsx|jsx|ts|js|mdx)$/.test(rel)) {
      route = `/${(m?.[1] ?? '').replace(/\([^)]+\)\/?/g, '')}`;
    } else if ((m = /^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|vue|astro|md|mdx)$/.exec(rel)) && !/^api\//.test(m[1]!) && !/^_/.test(path.basename(m[1]!))) {
      route = `/${m[1]!.replace(/(^|\/)index$/, '')}`;
    } else if ((m = /^src\/routes\/(.*?)\/?\+page\.svelte$/.exec(rel))) {
      route = `/${m[1]}`;
    } else if ((m = /^app\/routes\/(.+)\.(?:tsx|jsx|ts|js)$/.exec(rel))) {
      route = `/${m[1]!.replace(/^_index$/, '').replace(/\._index$/, '').replace(/\./g, '/').replace(/\$/g, ':')}`;
    }
    if (route !== null) routes.add(route.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/');
  }
  for (const [, source] of sources) {
    for (const match of source.matchAll(/\bpath\s*[:=]\s*["'`](\/[^"'`\s]*)["'`]/g)) {
      if (!match[1]!.includes('*')) routes.add(match[1]!);
    }
  }
  return [...routes].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 80);
}

function normalizeColor(value: string): string {
  return value.trim().toLowerCase();
}

export function extractBrand(styleSources: string[]) {
  const variables = new Map<string, string>();
  const colorCounts = new Map<string, {count: number; name?: string}>();
  const fonts = new Map<string, number>();
  const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)/g;

  for (const source of styleSources) {
    for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
      const name = match[1]!;
      const value = match[2]!.trim();
      if (!variables.has(name)) variables.set(name, value);
      const color = value.match(colorPattern)?.[0];
      if (color) {
        const key = normalizeColor(color);
        const entry = colorCounts.get(key) ?? {count: 0};
        entry.count += 3;
        entry.name ??= name;
        colorCounts.set(key, entry);
      }
    }
    for (const match of source.matchAll(colorPattern)) {
      const key = normalizeColor(match[0]);
      const entry = colorCounts.get(key) ?? {count: 0};
      entry.count += 1;
      colorCounts.set(key, entry);
    }
    for (const match of source.matchAll(/font-family\s*:\s*([^;}{]+)/g)) {
      const family = match[1]!.split(',')[0]!.trim().replace(/["']/g, '');
      if (family && !family.startsWith('var(') && !/^(inherit|initial|sans-serif|serif|monospace)$/.test(family)) {
        fonts.set(family, (fonts.get(family) ?? 0) + 1);
      }
    }
    for (const match of source.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^&"')]+)/g)) {
      const family = decodeURIComponent(match[1]!).split(':')[0]!.replace(/\+/g, ' ');
      fonts.set(family, (fonts.get(family) ?? 0) + 5);
    }
  }

  const neutral = /^(#fff|#ffffff|#000|#000000|transparent|rgba\(0,\s*0,\s*0,\s*0\))$/;
  return {
    colors: [...colorCounts.entries()]
      .filter(([value]) => !neutral.test(value))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 24)
      .map(([value, info]) => ({value, count: info.count, ...(info.name ? {name: info.name} : {})})),
    cssVariables: [...variables.entries()].slice(0, 150).map(([name, value]) => ({name, value})),
    fonts: [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([family]) => family),
  };
}

export function extractPitch(readme: string): {name: string | null; pitch: string | null} {
  if (!readme) return {name: null, pitch: null};
  const lines = readme.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const name = heading ? heading.replace(/^#\s+/, '').replace(/[*_`]/g, '').trim() : null;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length) paragraphs.push(current.join(' '));
      current = [];
      continue;
    }
    if (/^(#|!\[|\[!\[|<|```|\||-{3,}|>)/.test(trimmed)) {
      if (current.length) paragraphs.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(trimmed);
  }
  if (current.length) paragraphs.push(current.join(' '));
  const pitch = paragraphs.filter((p) => p.length > 30).slice(0, 2).join('\n\n') || null;
  return {name, pitch: pitch ? pitch.slice(0, 800) : null};
}

export function extractSeedAccounts(sources: Array<{file: string; text: string}>): Inventory['seedAccounts'] {
  const found: Inventory['seedAccounts'] = [];
  const seen = new Set<string>();
  for (const {file, text} of sources) {
    for (const match of text.matchAll(/([\w.+-]*(?:demo|test|seed|admin|example|user)[\w.+-]*@[\w-]+\.[\w.]+)/gi)) {
      const email = match[1]!;
      if (seen.has(email) || /noreply|example\.com\/|@types/.test(email)) continue;
      const window = text.slice(match.index!, match.index! + 300);
      const password = /pass(?:word)?["'`]?\s*[:=]\s*["'`]?([^\s"'`,;]{4,64})/i.exec(window)?.[1];
      seen.add(email);
      found.push({source: file, email, ...(password ? {password} : {})});
      if (found.length >= 10) return found;
    }
  }
  return found;
}

function classify(counts: Inventory['counts'], app: AppSignals | null, hasIndexHtml: boolean): LocationKind {
  if (counts.files === 0) return 'empty';
  if (app?.devCommand) return 'app';
  if (hasIndexHtml && counts.code < 50) return 'static-site';
  const media = counts.images + counts.videos;
  if (media > 0 && media >= counts.files * 0.6) return 'asset-folder';
  if (counts.docs > 0 && counts.docs >= counts.files * 0.5) return 'docs';
  return 'mixed';
}

export async function scanLocation(target: string, project?: Project): Promise<Inventory> {
  const root = path.resolve(target);
  const files = await walk(root);
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');

  const images: MediaFile[] = [];
  const videos: MediaFile[] = [];
  const docs: string[] = [];
  const styleSources: string[] = [];
  const codeSources = new Map<string, string>();
  const seedSources: Array<{file: string; text: string}> = [];
  const tokenFiles: string[] = [];
  let code = 0;
  let tailwindConfig: string | null = null;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file).toLowerCase();
    const relative = rel(file);
    if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) {
      const info = await stat(file);
      const entry: MediaFile = {path: relative, bytes: info.size};
      if (IMAGE_EXT.has(ext)) {
        const dims = images.length < 400 ? await readDimensions(file) : null;
        images.push(dims ? {...entry, ...dims} : entry);
      } else {
        videos.push(entry);
      }
      continue;
    }
    if (DOC_EXT.has(ext)) docs.push(relative);
    if (STYLE_EXT.has(ext) || ext === '.html' || ext === '.vue' || ext === '.svelte' || ext === '.astro') {
      if (styleSources.length < 300) styleSources.push(await readText(file));
    }
    if (/^tailwind\.config\.(js|cjs|mjs|ts)$/.test(name)) {
      tailwindConfig = relative;
      styleSources.push(await readText(file));
    }
    if (/tokens?\.(json|ya?ml|js|ts)$/.test(name) || /design-tokens/.test(relative)) tokenFiles.push(relative);
    if (CODE_EXT.has(ext)) {
      code += 1;
      if (codeSources.size < 600 && /rout|app|main|index/i.test(relative)) codeSources.set(relative, await readText(file));
    }
    if (/\.env\.example$|seed|fixture|readme/i.test(relative) && seedSources.length < 60) {
      seedSources.push({file: relative, text: await readText(file)});
    }
  }

  const packageJsonPath = path.join(root, 'package.json');
  let app: AppSignals | null = null;
  let packageName: string | null = null;
  let packageDescription: string | null = null;
  if (existsSync(packageJsonPath)) {
    const pkg = JSON.parse(await readText(packageJsonPath) || '{}');
    packageName = pkg.name ?? null;
    packageDescription = pkg.description ?? null;
    const deps = {...pkg.dependencies, ...pkg.devDependencies};
    const framework = FRAMEWORKS.find((f) => f.dep in deps) ?? null;
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const scriptName = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
    const packageManager = detectPackageManager(root);
    app = {
      packageManager,
      framework: framework?.name ?? null,
      devCommand: scriptName ? `${packageManager === 'npm' ? 'npm run' : packageManager} ${scriptName}` : null,
      port: portFromScript(scriptName ? scripts[scriptName] : undefined) ?? framework?.port ?? null,
      routes: [],
      storybook: existsSync(path.join(root, '.storybook')),
    };
  } else if (existsSync(path.join(root, 'manage.py'))) {
    app = {packageManager: null, framework: 'django', devCommand: 'python manage.py runserver', port: 8000, routes: [], storybook: false};
  } else if (existsSync(path.join(root, 'Gemfile')) && existsSync(path.join(root, 'config', 'routes.rb'))) {
    app = {
      packageManager: null,
      framework: 'rails',
      devCommand: existsSync(path.join(root, 'bin', 'dev')) ? 'bin/dev' : 'bin/rails server',
      port: 3000,
      routes: [],
      storybook: false,
    };
  }
  if (app) app.routes = detectRoutes(root, files, codeSources);

  const readmeFile = files.find((f) => /^readme(\.md|\.mdx|\.txt)?$/i.test(path.basename(f)) && path.dirname(f) === root);
  const {name: readmeName, pitch} = extractPitch(readmeFile ? await readText(readmeFile) : '');
  const brand = extractBrand(styleSources);
  const logos = images.filter((i) => /logo|brand|wordmark|favicon|apple-touch-icon|mark\./i.test(i.path)).map((i) => i.path);
  const screenshots = images.filter((i) => /screen(shot)?|preview|hero|demo/i.test(i.path)).map((i) => i.path);
  const hasIndexHtml = files.some((f) => /^(public\/)?index\.html$/.test(rel(f)));

  const counts = {files: files.length, images: images.length, videos: videos.length, docs: docs.length, code};
  const inventory: Inventory = {
    root,
    scannedAt: new Date().toISOString(),
    kind: classify(counts, app, hasIndexHtml),
    name: readmeName ?? packageName,
    pitch: pitch ?? packageDescription,
    app,
    brand: {...brand, tokenFiles: tokenFiles.slice(0, 20), tailwindConfig, logos: logos.slice(0, 20)},
    content: {
      images: images.sort((a, b) => b.bytes - a.bytes).slice(0, 120),
      videos: videos.slice(0, 40),
      screenshots: screenshots.slice(0, 40),
      docs: docs.slice(0, 60),
    },
    seedAccounts: extractSeedAccounts(seedSources),
    counts,
  };

  if (project) await writeJson(path.join(project.stateDir, 'inventory.json'), inventory);
  return inventory;
}

export async function scan(target?: string): Promise<Outcome<Inventory>> {
  const project = await loadProject();
  const inventory = await scanLocation(target ?? project.root, project);
  const next: string[] = [];
  if (inventory.kind === 'app') {
    next.push('gif-studio app start', 'gif-studio explore');
  } else if (inventory.kind === 'static-site') {
    next.push('gif-studio app start --static', 'gif-studio explore');
  } else {
    next.push('Propose a storyboard from inventory.content to the user', 'gif-studio new <asset> --template feature-highlight --format 16:9');
  }
  const app = inventory.app;
  const summary = [
    `Kind: ${inventory.kind}${inventory.name ? ` (${inventory.name})` : ''}`,
    app ? `App: ${app.framework ?? 'unknown framework'}, dev "${app.devCommand ?? 'none'}", port ${app.port ?? '?'}, ${app.routes.length} routes` : null,
    `Brand: ${inventory.brand.colors.slice(0, 5).map((c) => c.value).join(' ') || 'no colors'}; fonts ${inventory.brand.fonts.join(', ') || 'none'}; ${inventory.brand.logos.length} logos`,
    `Content: ${inventory.counts.images} images, ${inventory.counts.videos} videos, ${inventory.counts.docs} docs`,
    inventory.seedAccounts.length ? `Seed accounts: ${inventory.seedAccounts.map((a) => a.email).join(', ')}` : null,
    'Saved to .gif-studio/inventory.json',
  ]
    .filter(Boolean)
    .join('\n');
  return outcome(inventory, summary, next);
}
