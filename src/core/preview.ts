import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {listenOnFreePort} from './app.js';
import {listVersions, parseVersion, requireAsset, versionLabel} from './assets.js';
import {launchBrowser} from './browser.js';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {ensureStateDir, loadProject, relative} from './project.js';
import {createFileHandler} from '../server/files.js';

export interface SheetItem {
  label: string;
  file?: string;
  data?: Buffer;
}

export async function contactSheet(items: SheetItem[], options: {columns?: number; width?: number} = {}): Promise<Buffer> {
  const columns = options.columns ?? Math.min(3, Math.max(1, items.length));
  const width = options.width ?? 1500;
  const cards = await Promise.all(
    items.map(async (item) => {
      const buffer = item.data ?? (item.file ? await readFile(item.file) : null);
      const mime = item.file?.endsWith('.jpg') || item.file?.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      const src = buffer ? `data:${mime};base64,${buffer.toString('base64')}` : '';
      const label = item.label.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
      return `<figure><img src="${src}"/><figcaption>${label}</figcaption></figure>`;
    }),
  );
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({viewport: {width, height: 400}});
    await page.setContent(
      `<style>body{margin:0;padding:12px;background:#eef1f7;font:600 13px system-ui}main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:12px}figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 0 rgba(0,0,0,.08)}img{display:block;width:100%}figcaption{padding:6px 8px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><main>${cards.join('')}</main>`,
    );
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
    return await page.screenshot({fullPage: true, type: 'jpeg', quality: 70});
  } finally {
    await browser.close();
  }
}

export interface PreviewOptions {
  at?: number[];
  version?: string | number;
}

export async function previewScene(name: string, options: PreviewOptions = {}): Promise<Outcome<{frames: Array<{t: number; label: string; file: string}>; duration: number; sections: unknown[]; beats: unknown[]; errors: string[]}> & {sheet: Buffer}> {
  const project = await loadProject();
  await requireAsset(project, name);
  const requested = parseVersion(options.version);
  if (requested !== null && !(await listVersions(project, name)).some((v) => v.n === requested && !v.archived)) {
    throw new StudioError(`Version v${requested} not found.`);
  }
  const scenePath = requested !== null ? `/files/${encodeURIComponent(name)}/versions/${versionLabel(requested)}/scene.html` : `/files/${encodeURIComponent(name)}/scene.html`;
  const files = createFileHandler(project);
  const {server, url} = await listenOnFreePort((req, res) => {
    if (!files(req, res)) res.writeHead(404).end();
  });
  const browser = await launchBrowser();
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`${r.status()} ${r.url().replace(url, '')}`);
    });
    await page.goto(`${url}${scenePath}?render=1`);
    await page.waitForFunction(() => Boolean(window.__scene), undefined, {timeout: 20_000}).catch(() => {
      throw new StudioError(`scene.html did not define window.__scene.${errors.length ? `\nErrors:\n${errors.join('\n')}` : ''}`, 'Fix the errors above; the scene must call scene.done().');
    });
    await page.evaluate(() => window.__scene!.ready);
    const manifest = await page.evaluate(() => ({width: window.__scene!.width, height: window.__scene!.height, duration: window.__scene!.duration, sections: window.__scene!.sections, beats: window.__scene!.beats}));
    await page.setViewportSize({width: manifest.width, height: manifest.height});

    const times = options.at?.length
      ? options.at.map((t) => ({t, label: `${(t / 1000).toFixed(2)}s`}))
      : [{t: 0, label: 'start'}, ...manifest.beats.map((b) => ({t: Math.min(b.t + 120, manifest.duration), label: `${(b.t / 1000).toFixed(2)}s ${b.label}`})), {t: manifest.duration - 1, label: 'end'}].slice(0, 12);

    const dir = await ensureStateDir(project, 'preview', name);
    const frames: Array<{t: number; label: string; file: string}> = [];
    const items: SheetItem[] = [];
    for (const [i, {t, label}] of times.entries()) {
      await page.evaluate(async (time) => {
        await window.__scene!.seek(time);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, t);
      const file = path.join(dir, `${String(i).padStart(2, '0')}.png`);
      const data = await page.screenshot({path: file});
      frames.push({t, label, file: relative(project, file)});
      items.push({label, data});
    }
    await page.close();
    await browser.close();
    const sheet = await contactSheet(items, {columns: manifest.width > manifest.height ? 3 : 4});
    const summary = [
      `Preview of ${name}${requested !== null ? ` v${requested}` : ' (working copy)'}: ${(manifest.duration / 1000).toFixed(1)}s, ${manifest.width}x${manifest.height}, ${manifest.sections.length} sections, ${manifest.beats.length} beats`,
      ...frames.map((f) => `  ${f.label}: ${f.file}`),
      errors.length ? `Page errors:\n${errors.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {...outcome({frames, duration: manifest.duration, sections: manifest.sections, beats: manifest.beats, errors}, summary, [`gif-studio render ${name}`]), sheet};
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}
