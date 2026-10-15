import {mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {Page} from 'playwright-core';
import {resolveAppUrl} from './app.js';
import {applyMasks, contextOptions, launchBrowser, locate, settle, type Box, type Target} from './browser.js';
import {ffmpeg} from './ffmpeg.js';
import {getJourney, type JourneyStep} from './journeys.js';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {loadProject, relative, writeJson, type Project} from './project.js';

export type PlateAction =
  | {type: 'click' | 'hover'; box: Box; label: string}
  | {type: 'type'; box: Box; text: string; label: string}
  | {type: 'press'; key: string}
  | {type: 'scroll'; fromY: number; toY: number};

export interface Plate {
  index: number;
  file: string;
  url: string;
  scrollY: number;
  beat?: string;
  caption?: string;
  hold?: number;
  action?: PlateAction;
}

export interface PlatesManifest {
  journey: string;
  title: string;
  viewport: {width: number; height: number};
  scale: number;
  recordedAt: string;
  plates: Plate[];
}

export interface FootageManifest {
  journey: string;
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  video: string;
  framesDir: string;
  markers: Array<{t: number; label: string; step: number}>;
}

export type RecordMode = 'plates' | 'footage' | 'both';

export function capturesDir(project: Project, journey: string): string {
  return path.join(project.assetsDir, 'captures', journey);
}

function typeTarget(step: Extract<JourneyStep, {type: unknown}>['type']): Target {
  if (step.target) return step.target;
  if (step.label) return {label: step.label};
  if (step.placeholder) return {placeholder: step.placeholder};
  if (step.selector) return {selector: step.selector};
  throw new StudioError('type step needs target, label, placeholder or selector.');
}

function labelOf(target: Target): string {
  if (typeof target === 'string') return target;
  return target.name ?? target.text ?? target.label ?? target.placeholder ?? target.testId ?? target.selector ?? '';
}

async function boxOf(page: Page, target: Target): Promise<Box> {
  const locator = locate(page, target);
  await locator.waitFor({state: 'visible', timeout: 15_000});
  await locator.scrollIntoViewIfNeeded({timeout: 5000}).catch(() => undefined);
  const box = await locator.boundingBox();
  if (!box) throw new StudioError(`Element not visible: ${JSON.stringify(target)}`);
  return {x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height)};
}

export interface RecordOptions {
  mode?: RecordMode;
  scale?: number;
  fps?: number;
}

export async function record(journeyId: string, options: RecordOptions = {}): Promise<Outcome<{plates?: PlatesManifest; footage?: FootageManifest; dir: string}>> {
  const project = await loadProject();
  const journey = await getJourney(project, journeyId);
  const mode = options.mode ?? 'plates';
  const scale = options.scale ?? project.config.render.scale;
  const fps = options.fps ?? 30;
  const viewport = journey.viewport ?? project.config.viewport;
  const dir = capturesDir(project, journey.id);
  const platesDir = path.join(dir, 'plates');
  const footageDir = path.join(dir, 'footage');
  const wantPlates = mode !== 'footage';
  const wantFootage = mode !== 'plates';
  if (wantPlates) {
    await rm(platesDir, {recursive: true, force: true});
    await mkdir(platesDir, {recursive: true});
  }
  if (wantFootage) {
    await rm(footageDir, {recursive: true, force: true});
    await mkdir(path.join(footageDir, 'frames'), {recursive: true});
  }

  const browser = await launchBrowser();
  const context = await browser.newContext(
    contextOptions(project, {
      auth: journey.auth,
      viewport,
      deviceScaleFactor: wantPlates ? scale : 1,
    }),
  );
  const page = await context.newPage();
  const plates: Plate[] = [];
  const markers: FootageManifest['markers'] = [];
  const t0 = Date.now();
  const screencast = wantFootage ? await startScreencast(page, path.join(footageDir, 'raw'), viewport) : null;

  const scrollY = () => page.evaluate(() => window.scrollY).catch(() => 0);
  const capture = async (step: JourneyStep) => {
    if (!wantPlates) return;
    await applyMasks(page, project);
    const index = plates.length;
    const file = path.join(platesDir, `${String(index).padStart(2, '0')}.png`);
    await page.screenshot({path: file});
    plates.push({
      index,
      file: `plates/${path.basename(file)}`,
      url: page.url(),
      scrollY: await scrollY(),
      ...(step.beat ? {beat: step.beat} : {}),
      ...(step.caption ? {caption: step.caption} : {}),
      ...(step.hold ? {hold: step.hold} : {}),
    });
  };
  const attach = async (action: PlateAction) => {
    if (!wantPlates) return;
    const last = plates[plates.length - 1];
    const currentScroll = await scrollY();
    if (!last || last.action || last.scrollY !== currentScroll) {
      await capture({capture: 'pre-action'});
    }
    plates[plates.length - 1]!.action = action;
  };

  try {
    for (const [i, step] of journey.steps.entries()) {
      markers.push({t: Date.now() - t0, label: step.beat ?? Object.keys(step)[0]!, step: i});
      if ('goto' in step) {
        await page.goto(await resolveAppUrl(project, step.goto), {waitUntil: 'domcontentloaded', timeout: 60_000});
        await settle(page, 500);
        await capture(step);
      } else if ('click' in step) {
        const box = await boxOf(page, step.click);
        await attach({type: 'click', box, label: labelOf(step.click)});
        if (wantFootage) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 20});
        await locate(page, step.click).click({timeout: 10_000});
        await settle(page);
        await capture(step);
      } else if ('hover' in step) {
        const box = await boxOf(page, step.hover);
        await attach({type: 'hover', box, label: labelOf(step.hover)});
        await locate(page, step.hover).hover({timeout: 10_000});
        await page.waitForTimeout(400);
        await capture(step);
      } else if ('type' in step) {
        const target = typeTarget(step.type);
        const box = await boxOf(page, target);
        await attach({type: 'type', box, text: step.type.text, label: labelOf(target)});
        const locator = locate(page, target);
        await locator.click({timeout: 10_000}).catch(() => undefined);
        await locator.fill('');
        await locator.pressSequentially(step.type.text, {delay: wantFootage || step.type.human ? 55 : 5});
        if (step.type.submit) await locator.press('Enter');
        await settle(page);
        await capture(step);
      } else if ('press' in step) {
        await attach({type: 'press', key: step.press});
        await page.keyboard.press(step.press);
        await settle(page);
        await capture(step);
      } else if ('scroll' in step) {
        const fromY = await scrollY();
        if (step.scroll.to) await locate(page, step.scroll.to).scrollIntoViewIfNeeded({timeout: 10_000});
        else await page.mouse.wheel(0, step.scroll.y ?? 600);
        await page.waitForTimeout(600);
        const toY = await scrollY();
        if (wantPlates && plates.length) plates[plates.length - 1]!.action ??= {type: 'scroll', fromY, toY};
        await capture(step);
      } else if ('waitFor' in step) {
        const wait = step.waitFor;
        if (typeof wait === 'object' && 'ms' in wait && typeof wait.ms === 'number') await page.waitForTimeout(wait.ms);
        else await locate(page, wait as Target).waitFor({state: 'visible', timeout: 30_000});
        await settle(page, 200);
        await capture(step);
      } else if ('capture' in step) {
        await settle(page, 200);
        await capture(step);
      }
    }
    if (wantFootage) await page.waitForTimeout(800);
  } finally {
    await screencast?.stop();
    await context.close();
    await browser.close();
  }

  const result: {plates?: PlatesManifest; footage?: FootageManifest; dir: string} = {dir: relative(project, dir)};
  if (wantPlates) {
    result.plates = {journey: journey.id, title: journey.title, viewport, scale, recordedAt: new Date().toISOString(), plates};
    await writeJson(path.join(dir, 'plates.json'), result.plates);
  }
  if (wantFootage) {
    const frames = screencast!.frames;
    if (frames.length < 2) throw new StudioError('Footage recording captured no frames.');
    const list = frames
      .map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.ts ?? frame.ts + 0.5) - frame.ts)).toFixed(4)}`)
      .join('\n');
    const listFile = path.join(footageDir, 'raw', 'frames.txt');
    await writeFile(listFile, `ffconcat version 1.0\n${list}\nfile '${frames[frames.length - 1]!.file}'\n`);
    const video = path.join(footageDir, 'footage.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', video]);
    await ffmpeg(['-i', video, '-q:v', '3', path.join(footageDir, 'frames', '%05d.jpg')]);
    await rm(path.join(footageDir, 'raw'), {recursive: true, force: true});
    const frameCount = (await readdir(path.join(footageDir, 'frames'))).length;
    const firstTs = frames[0]!.ts * 1000;
    for (const marker of markers) marker.t = Math.max(0, marker.t - (firstTs - t0));
    result.footage = {
      journey: journey.id,
      fps,
      frameCount,
      width: viewport.width,
      height: viewport.height,
      video: 'footage/footage.mp4',
      framesDir: 'footage/frames',
      markers,
    };
    await writeJson(path.join(dir, 'footage.json'), result.footage);
  }

  const parts = [
    result.plates ? `${result.plates.plates.length} plates (${scale}x) in ${result.dir}/plates` : null,
    result.footage ? `footage ${Math.round((result.footage.frameCount / fps) * 10) / 10}s (${result.footage.frameCount} frames) in ${result.dir}/footage` : null,
  ].filter(Boolean);
  return outcome(result, `Recorded "${journey.title}": ${parts.join('; ')}`, [
    `Look at the plates in ${result.dir}/plates to check every state is right`,
    `gif-studio new ${journey.id} --template product-walkthrough --journey ${journey.id} --format 16:9`,
  ]);
}

async function startScreencast(page: Page, dir: string, viewport: {width: number; height: number}) {
  await mkdir(dir, {recursive: true});
  const session = await page.context().newCDPSession(page);
  const frames: Array<{file: string; ts: number}> = [];
  const writes: Promise<void>[] = [];
  session.on('Page.screencastFrame', (event: {data: string; sessionId: number; metadata: {timestamp?: number}}) => {
    const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({file, ts: event.metadata.timestamp ?? Date.now() / 1000});
    writes.push(writeFile(file, Buffer.from(event.data, 'base64')));
    void session.send('Page.screencastFrameAck', {sessionId: event.sessionId}).catch(() => undefined);
  });
  await session.send('Page.startScreencast', {format: 'jpeg', quality: 88, maxWidth: viewport.width * 2, maxHeight: viewport.height * 2, everyNthFrame: 1});
  return {
    frames,
    stop: async () => {
      await session.send('Page.stopScreencast').catch(() => undefined);
      await Promise.all(writes);
      await session.detach().catch(() => undefined);
    },
  };
}
