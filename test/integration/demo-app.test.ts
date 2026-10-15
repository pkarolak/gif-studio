import {execFile} from 'node:child_process';
import {cpSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {probe} from '../../src/core/ffmpeg.js';
import {tempDir} from '../helpers.js';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..', '..');
const cli = path.join(repo, 'dist', 'cli', 'index.js');

let root = '';
let cleanup = () => {};

async function gs<T = unknown>(...args: string[]): Promise<{ok: boolean; data: T; summary: string; next: string[]}> {
  const {stdout} = await exec(process.execPath, [cli, ...args, '--json'], {cwd: root, maxBuffer: 32 * 1024 * 1024, env: {...process.env, GIF_STUDIO_ROOT: root}});
  return JSON.parse(stdout);
}

const journey = {
  id: 'create-project',
  title: 'Create a project in seconds',
  steps: [
    {goto: '/', beat: 'Projects'},
    {click: {role: 'button', name: 'New project'}, beat: 'New project'},
    {type: {label: 'Project name', text: 'Q3 launch plan'}, beat: 'Name it'},
    {click: {role: 'button', name: 'Create project'}, beat: 'Created', hold: 1000},
  ],
};

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error('Run npm run build before the integration tests.');
  const temp = tempDir('gif-studio-it-');
  root = temp.dir;
  cleanup = temp.cleanup;
  cpSync(path.join(repo, 'examples', 'demo-app'), root, {recursive: true});
  await gs('init', '--no-skill', '--no-mcp');
});

afterAll(async () => {
  await gs('app', 'stop').catch(() => undefined);
  cleanup();
});

describe('demo app end to end', () => {
  it('scans the app', async () => {
    const scan = await gs<{kind: string; name: string}>('scan');
    expect(scan.ok).toBe(true);
    expect(scan.data.kind).toBe('app');
  });

  it('starts and explores the app', async () => {
    const app = await gs<{url: string}>('app', 'start');
    expect(app.data.url).toMatch(/^http:\/\/localhost:\d+/);
    const explore = await gs<{pages: unknown[]}>('explore', '--max-pages', '4');
    expect(explore.data.pages.length).toBeGreaterThan(0);
  });

  it('records a journey and renders GIF + MP4 + stills', async () => {
    const {writeFileSync} = await import('node:fs');
    writeFileSync(path.join(root, 'journey.json'), JSON.stringify(journey));
    await gs('journeys', 'save', 'journey.json');
    const record = await gs<{plates: number}>('record', 'create-project');
    expect(record.ok).toBe(true);
    expect(existsSync(path.join(root, 'marketing/gifs/captures/create-project/plates.json'))).toBe(true);

    await gs('new', 'walkthrough', '--template', 'product-walkthrough', '--journey', 'create-project');
    const preview = await gs<{errors?: string[]}>('preview', 'walkthrough');
    expect(preview.ok).toBe(true);

    const render = await gs<{version: string; outputs: Array<{format: string; file: string}>; stills: string[]}>('render', 'walkthrough', '--workers', '2');
    expect(render.data.version).toBe('v1');
    expect(render.data.stills.length).toBeGreaterThan(0);
    const mp4 = render.data.outputs.find((o) => o.format === 'mp4')!;
    const gif = render.data.outputs.find((o) => o.format === 'gif')!;
    const mp4Info = await probe(path.join(root, mp4.file));
    const gifInfo = await probe(path.join(root, gif.file));
    expect(mp4Info).toMatchObject({width: 1920, height: 1080});
    expect(mp4Info.durationMs).toBeGreaterThan(4000);
    expect(gifInfo).toMatchObject({width: 960, height: 540});
    expect(statSync(path.join(root, gif.file)).size).toBeLessThan(8 * 1024 * 1024);

    const promote = await gs('promote', 'walkthrough', 'v1');
    expect(promote.ok).toBe(true);
    expect(existsSync(path.join(root, 'marketing/gifs/walkthrough/final/walkthrough.gif'))).toBe(true);
  });
});
