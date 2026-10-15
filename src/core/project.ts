import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

export const CONFIG_FILE = 'gif-studio.config.json';
export const STATE_DIR = '.gif-studio';

export const configSchema = z.object({
  assetsDir: z.string().default('marketing/gifs'),
  studioPort: z.number().int().default(4455),
  viewport: z.object({width: z.number().int(), height: z.number().int()}).default({width: 1440, height: 900}),
  app: z
    .object({
      command: z.string().optional(),
      url: z.string().optional(),
      cwd: z.string().optional(),
    })
    .default({}),
  auth: z.string().optional(),
  mask: z.array(z.string()).default([]),
  replace: z.record(z.string(), z.string()).default({}),
  render: z
    .object({
      fps: z.number().int().default(30),
      scale: z.number().default(2),
      gifFps: z.number().int().default(20),
      gifScale: z.number().default(1),
      formats: z.array(z.enum(['gif', 'mp4'])).default(['gif', 'mp4']),
      workers: z.number().int().default(4),
    })
    .default({fps: 30, scale: 2, gifFps: 20, gifScale: 1, formats: ['gif', 'mp4'], workers: 4}),
});

export type StudioConfig = z.infer<typeof configSchema>;

export interface Project {
  root: string;
  config: StudioConfig;
  hasConfig: boolean;
  assetsDir: string;
  stateDir: string;
}

export function findProjectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export async function loadProject(cwd?: string): Promise<Project> {
  const root = findProjectRoot(cwd ?? process.env.GIF_STUDIO_ROOT ?? process.cwd());
  const configPath = path.join(root, CONFIG_FILE);
  const hasConfig = existsSync(configPath);
  const raw = hasConfig ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  const config = configSchema.parse(raw);
  return {
    root,
    config,
    hasConfig,
    assetsDir: path.join(root, config.assetsDir),
    stateDir: path.join(root, STATE_DIR),
  };
}

export async function ensureStateDir(project: Project, ...segments: string[]): Promise<string> {
  const dir = path.join(project.stateDir, ...segments);
  await mkdir(dir, {recursive: true});
  return dir;
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('gif-studio package root not found');
    dir = parent;
  }
  return dir;
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

export function relative(project: Project, file: string): string {
  return path.relative(project.root, file) || '.';
}
