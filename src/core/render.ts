import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Page} from 'playwright-core';
import {buildPacing, pacedDuration, studioToScene} from '../shared/pacing.js';
import type {SceneManifest} from '../shared/contract.js';
import {listenOnFreePort} from './app.js';
import {listVersions, nextVersion, outputName, parseVersion, readPacing, requireAsset, snapshotScene, versionLabel} from './assets.js';
import {launchBrowser} from './browser.js';
import {ffmpeg, hasBinary, run} from './ffmpeg.js';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {loadProject, relative, slugify, writeJson} from './project.js';
import {createFileHandler} from '../server/files.js';

export type RenderFormat = 'gif' | 'mp4';

export interface RenderProgress {
  phase: 'snapshot' | 'capture' | 'stills' | 'encode-mp4' | 'encode-gif' | 'done';
  done: number;
  total: number;
}

export interface RenderOptions {
  version?: string | number;
  formats?: RenderFormat[];
  fps?: number;
  scale?: number;
  gifFps?: number;
  gifScale?: number;
  workers?: number;
  stills?: boolean;
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderResult {
  asset: string;
  version: string;
  durationMs: number;
  frames: number;
  outputs: Array<{format: RenderFormat; file: string; bytes: number}>;
  stills: string[];
}

async function waitForScene(page: Page): Promise<SceneManifest> {
  await page.waitForFunction(() => Boolean(window.__scene), undefined, {timeout: 30_000}).catch(async () => {
    throw new StudioError('scene.html never defined window.__scene.', 'Check the browser console: open the scene with gif-studio studio. The scene must call scene.done() (runtime) or set window.__scene.');
  });
  await page.evaluate(() => window.__scene?.ready);
  return page.evaluate(() => {
    const s = window.__scene!;
    return {width: s.width, height: s.height, duration: s.duration, sections: s.sections ?? [], beats: s.beats ?? []};
  });
}

async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate(async (time) => {
    await window.__scene!.seek(time);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, t);
}

export async function renderAsset(name: string, options: RenderOptions = {}): Promise<Outcome<RenderResult>> {
  const project = await loadProject();
  const dir = await requireAsset(project, name);
  const config = project.config.render;
  const formats = options.formats ?? config.formats;
  const fps = options.fps ?? config.fps;
  const scale = options.scale ?? config.scale;
  const gifFps = options.gifFps ?? config.gifFps;
  const gifScale = options.gifScale ?? config.gifScale;
  const workers = Math.max(1, options.workers ?? config.workers);
  const report = options.onProgress ?? (() => undefined);

  const requested = parseVersion(options.version);
  let n: number;
  if (requested !== null) {
    const versions = await listVersions(project, name);
    if (!versions.some((v) => v.n === requested && !v.archived)) throw new StudioError(`Version v${requested} not found.`, `Available: ${versions.filter((v) => !v.archived).map((v) => v.label).join(', ') || 'none'}`);
    n = requested;
  } else {
    report({phase: 'snapshot', done: 0, total: 1});
    n = await nextVersion(project, name);
    await snapshotScene(project, name, n);
  }
  const versionDir = path.join(dir, 'versions', versionLabel(n));

  const files = createFileHandler(project);
  const {server, url} = await listenOnFreePort((req, res) => {
    if (!files(req, res)) res.writeHead(404).end('Not found');
  });
  const browser = await launchBrowser();
  const frameDir = await mkdtemp(path.join(os.tmpdir(), `gif-studio-${slugify(name)}-`));
  try {
    const sceneUrl = `${url}/files/${encodeURIComponent(name)}/versions/${versionLabel(n)}/scene.html?render=1`;
    const probe = await browser.newPage();
    const errors: string[] = [];
    probe.on('pageerror', (e) => errors.push(e.message));
    await probe.goto(sceneUrl);
    const manifest = await waitForScene(probe).catch((e: Error) => {
      throw new StudioError(`${e.message}${errors.length ? `\nPage errors:\n${errors.join('\n')}` : ''}`, (e as StudioError).hint);
    });
    await probe.close();
    if (!manifest.duration || manifest.duration <= 0) throw new StudioError('Scene duration is 0.', 'Add timeline content or pass a duration to scene.done({duration}).');

    const segments = buildPacing(manifest.duration, manifest.sections, await readPacing(project, name));
    const total = pacedDuration(segments);
    const frameCount = Math.max(1, Math.round((total / 1000) * fps));
    const context = await browser.newContext({viewport: {width: manifest.width, height: manifest.height}, deviceScaleFactor: scale});

    let done = 0;
    const chunk = Math.ceil(frameCount / workers);
    await Promise.all(
      Array.from({length: workers}, async (_, w) => {
        const start = w * chunk;
        const end = Math.min(frameCount, start + chunk);
        if (start >= end) return;
        const page = await context.newPage();
        await page.goto(sceneUrl);
        await waitForScene(page);
        for (let i = start; i < end; i++) {
          await seek(page, studioToScene(segments, (i * 1000) / fps));
          await page.screenshot({path: path.join(frameDir, `frame_${String(i).padStart(5, '0')}.png`)});
          done++;
          if (done % 5 === 0 || done === frameCount) report({phase: 'capture', done, total: frameCount});
        }
        await page.close();
      }),
    );

    const stills: string[] = [];
    if (options.stills ?? true) {
      const stillsDir = path.join(versionDir, 'stills');
      await rm(stillsDir, {recursive: true, force: true});
      await mkdir(stillsDir, {recursive: true});
      const page = await context.newPage();
      await page.goto(sceneUrl);
      await waitForScene(page);
      const beats = manifest.beats.length ? manifest.beats : [{t: manifest.duration / 2, label: 'middle'}];
      for (const [i, beat] of beats.entries()) {
        report({phase: 'stills', done: i, total: beats.length});
        await seek(page, Math.min(beat.t + 120, manifest.duration));
        const file = path.join(stillsDir, `${String(i + 1).padStart(2, '0')}-${slugify(beat.label)}.png`);
        await page.screenshot({path: file});
        stills.push(relative(project, file));
      }
      await page.close();
    }
    await context.close();

    const versionsDir = path.join(dir, 'versions');
    for (const file of await readdir(versionsDir)) {
      if (file.startsWith(`${name}-v${n}-`)) await rm(path.join(versionsDir, file));
    }
    const outputs: RenderResult['outputs'] = [];
    const pattern = path.join(frameDir, 'frame_%05d.png');
    if (formats.includes('mp4')) {
      report({phase: 'encode-mp4', done: 0, total: 1});
      const file = path.join(versionsDir, outputName(name, n, total, 'mp4'));
      await ffmpeg(['-framerate', String(fps), '-i', pattern, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', file]);
      outputs.push({format: 'mp4', file: relative(project, file), bytes: (await stat(file)).size});
    }
    if (formats.includes('gif')) {
      report({phase: 'encode-gif', done: 0, total: 1});
      const file = path.join(versionsDir, outputName(name, n, total, 'gif'));
      const width = Math.round(manifest.width * gifScale);
      if (hasBinary('gifski')) {
        const step = fps / gifFps;
        const picked: string[] = [];
        for (let f = 0; f < frameCount; f += step) picked.push(path.join(frameDir, `frame_${String(Math.round(f)).padStart(5, '0')}.png`));
        await run('gifski', ['--fps', String(gifFps), '--width', String(width), '--quality', '90', '-o', file, ...picked.filter((p) => existsSync(p))]);
      } else {
        await ffmpeg([
          '-framerate', String(fps), '-i', pattern,
          '-vf', `fps=${gifFps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
          '-loop', '0', file,
        ]);
      }
      outputs.push({format: 'gif', file: relative(project, file), bytes: (await stat(file)).size});
    }

    await writeJson(path.join(versionDir, 'meta.json'), {
      version: n,
      durationMs: Math.round(total),
      sceneDurationMs: manifest.duration,
      frames: frameCount,
      fps,
      scale,
      gifFps,
      pacing: await readPacing(project, name),
      createdAt: new Date().toISOString(),
    });
    report({phase: 'done', done: 1, total: 1});

    const result: RenderResult = {asset: name, version: versionLabel(n), durationMs: Math.round(total), frames: frameCount, outputs, stills};
    const sizes = outputs.map((o) => `${o.file} (${(o.bytes / 1024 / 1024).toFixed(1)} MB)`).join('\n  ');
    return outcome(result, `Rendered ${name} ${versionLabel(n)}: ${(total / 1000).toFixed(1)}s, ${frameCount} frames\n  ${sizes}`, [
      `Look at the stills in ${relative(project, path.join(versionDir, 'stills'))} to sanity-check key beats`,
      'gif-studio studio  # ask the user to review and leave notes',
      `gif-studio promote ${name} ${versionLabel(n)}  # once the user approves`,
    ]);
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    await rm(frameDir, {recursive: true, force: true});
  }
}