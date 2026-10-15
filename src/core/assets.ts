import {existsSync} from 'node:fs';
import {copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {resolveFormat} from '../shared/contract.js';
import {getJourney} from './journeys.js';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {loadProject, packageRoot, readJson, relative, slugify, writeJson, type Project} from './project.js';
import {capturesDir} from './record.js';
import type {Inventory} from './scan.js';

export const RESERVED_DIRS = new Set(['captures']);

export const TEMPLATES = [
  {id: 'product-walkthrough', needs: 'journey', description: 'Real app journey from recorded plates: cursor, clicks, typing, camera zooms, captions. Best for "how it works" loops.'},
  {id: 'feature-highlight', needs: 'image', description: 'One hero screenshot or image with a headline, zoom into a region and a callout. Best for single-feature announcements.'},
  {id: 'step-card-loop', needs: 'images', description: 'Numbered steps (2-5), each with its own visual and one line of copy. Best for onboarding cards and "3 steps to…".'},
  {id: 'before-after', needs: 'two images', description: 'Wipe reveal between a before and an after visual. Best for redesigns, improvements, AI transformations.'},
  {id: 'synthetic', needs: 'nothing', description: 'Blank seekable scene for a pure HTML/CSS recreation built from the repo\'s tokens and components (the original walkthrough approach).'},
] as const;

export type TemplateId = (typeof TEMPLATES)[number]['id'];

export interface VersionInfo {
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
}

export interface NoteWithStatus extends Note {
  coveredIn: number | null;
  open: boolean;
}

export function assetDir(project: Project, name: string): string {
  return path.join(project.assetsDir, name);
}

export async function requireAsset(project: Project, name: string): Promise<string> {
  const dir = assetDir(project, name);
  if (!existsSync(path.join(dir, 'scene.html'))) {
    const known = await listAssetNames(project);
    throw new StudioError(`Asset "${name}" not found.`, `Known assets: ${known.join(', ') || 'none'}. Create one with gif-studio new <asset>.`);
  }
  return dir;
}

export async function listAssetNames(project: Project): Promise<string[]> {
  if (!existsSync(project.assetsDir)) return [];
  const entries = await readdir(project.assetsDir, {withFileTypes: true});
  return entries
    .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name) && existsSync(path.join(project.assetsDir, e.name, 'scene.html')))
    .map((e) => e.name)
    .sort();
}

export function versionLabel(n: number): string {
  return `v${n}`;
}

export function parseVersion(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const match = /^v?(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function outputName(asset: string, n: number, durationMs: number, format: string): string {
  return `${asset}-v${n}-${(durationMs / 1000).toFixed(1)}s.${format}`;
}

export async function listVersions(project: Project, name: string): Promise<VersionInfo[]> {
  const dir = assetDir(project, name);
  const versions: VersionInfo[] = [];
  for (const [folder, archived] of [
    ['versions', false],
    ['archive', true],
  ] as const) {
    const base = path.join(dir, folder);
    if (!existsSync(base)) continue;
    const entries = await readdir(base, {withFileTypes: true});
    for (const entry of entries) {
      const match = /^v(\d+)$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const n = Number(match[1]);
      const meta = await readJson<{durationMs?: number; createdAt?: string} | null>(path.join(base, entry.name, 'meta.json'), null);
      const outputs: VersionInfo['outputs'] = [];
      for (const file of entries.filter((e) => e.isFile() && e.name.startsWith(`${name}-v${n}-`))) {
        outputs.push({format: path.extname(file.name).slice(1), file: relative(project, path.join(base, file.name)), bytes: (await stat(path.join(base, file.name))).size});
      }
      versions.push({n, label: versionLabel(n), dir: relative(project, path.join(base, entry.name)), archived, durationMs: meta?.durationMs ?? null, createdAt: meta?.createdAt ?? null, outputs});
    }
  }
  return versions.sort((a, b) => a.n - b.n);
}

export async function nextVersion(project: Project, name: string): Promise<number> {
  const versions = await listVersions(project, name);
  return versions.length ? Math.max(...versions.map((v) => v.n)) + 1 : 1;
}

export async function snapshotScene(project: Project, name: string, n: number): Promise<string> {
  const dir = assetDir(project, name);
  const target = path.join(dir, 'versions', versionLabel(n));
  await mkdir(target, {recursive: true});
  const html = await readFile(path.join(dir, 'scene.html'), 'utf8');
  const withBase = /<base\s/i.test(html) ? html : html.replace(/<head([^>]*)>/i, `<head$1>\n<base href="../../">`);
  await writeFile(path.join(target, 'scene.html'), withBase);
  return target;
}

const notesFile = (project: Project, name: string) => path.join(assetDir(project, name), 'notes.json');

export async function readNotes(project: Project, name: string): Promise<Note[]> {
  return (await readJson<{notes: Note[]}>(notesFile(project, name), {notes: []})).notes;
}

export async function writeNotes(project: Project, name: string, notes: Note[]): Promise<void> {
  await writeJson(notesFile(project, name), {notes});
}

export function withStatus(notes: Note[], versions: number[]): NoteWithStatus[] {
  return notes.map((note) => {
    const coveredIn = versions.filter((n) => n > note.version).sort((a, b) => a - b)[0] ?? null;
    return {...note, coveredIn, open: !note.done && coveredIn === null};
  });
}

export async function notesFor(name: string, options: {version?: string | number; open?: boolean} = {}): Promise<Outcome<{asset: string; notes: NoteWithStatus[]; markdown: string}>> {
  const project = await loadProject();
  await requireAsset(project, name);
  const versions = (await listVersions(project, name)).map((v) => v.n);
  const target = parseVersion(options.version);
  let notes = withStatus(await readNotes(project, name), versions);
  if (target !== null) notes = notes.filter((n) => n.version === target && !n.done);
  else if (options.open) notes = notes.filter((n) => n.open);
  notes.sort((a, b) => a.t - b.t);

  const dir = assetDir(project, name);
  const markdown = notes.length
    ? [
        `# Notes for ${name}${target !== null ? ` from v${target}` : ''}`,
        '',
        ...notes.map((n, i) =>
          [
            `${i + 1}. [${n.id} · ${(n.t / 1000).toFixed(2)}s @ ${Math.round(n.x * 100)}%,${Math.round(n.y * 100)}%] ${n.text}${n.done ? ' (done)' : n.coveredIn ? ` (covered in v${n.coveredIn})` : ''}`,
            ...n.attachments.map((a) => `   - attachment: ${relative(project, path.join(dir, a))}`),
          ].join('\n'),
        ),
      ].join('\n')
    : `No ${target !== null ? `notes on v${target}` : options.open ? 'open notes' : 'notes'} for ${name}.`;

  const latest = versions.length ? Math.max(...versions) : 0;
  return outcome({asset: name, notes, markdown}, markdown, notes.length ? [`Edit ${relative(project, path.join(dir, 'scene.html'))} to address every note, then: gif-studio render ${name}`, `Mark each addressed note: gif-studio notes ${name} --done <id>`, `Report what changed per note; the studio marks them "Covered in v${latest + 1}"`] : []);
}

export async function resolveNote(name: string, id: string, done = true): Promise<Outcome<Note>> {
  const project = await loadProject();
  const notes = await readNotes(project, name);
  const note = notes.find((n) => n.id === id);
  if (!note) throw new StudioError(`Note ${id} not found on ${name}.`);
  note.done = done;
  await writeNotes(project, name, notes);
  return outcome(note, `Note ${id} marked ${done ? 'done' : 'open'}.`);
}

const pacingFile = (project: Project, name: string) => path.join(assetDir(project, name), 'pacing.json');

export async function readPacing(project: Project, name: string): Promise<Record<string, number>> {
  return (await readJson<{speeds: Record<string, number>}>(pacingFile(project, name), {speeds: {}})).speeds;
}

export async function writePacing(project: Project, name: string, speeds: Record<string, number>): Promise<void> {
  await writeJson(pacingFile(project, name), {speeds});
}

export async function setPacing(name: string, speeds?: Record<string, number>): Promise<Outcome<Record<string, number>>> {
  const project = await loadProject();
  await requireAsset(project, name);
  if (speeds) {
    const merged = {...(await readPacing(project, name)), ...speeds};
    for (const [key, value] of Object.entries(merged)) if (value === 1) delete merged[key];
    await writePacing(project, name, merged);
  }
  const current = await readPacing(project, name);
  return outcome(current, Object.keys(current).length ? Object.entries(current).map(([k, v]) => `${k}: ${v}x`).join('\n') : 'All sections at 1x.', [`gif-studio render ${name} --version <vN>  # re-encode with the new pacing`]);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

function pickPrimary(inventory: Inventory | null): {primary: string; accent: string} {
  const colors = (inventory?.brand.colors ?? []).map((c) => c.value).filter((c) => /^#[0-9a-f]{6}$/.test(c));
  const saturated = colors.filter((hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) > 60;
  });
  return {primary: saturated[0] ?? '#4262FF', accent: saturated[1] ?? '#FFD02F'};
}

export interface NewAssetOptions {
  template?: TemplateId;
  format?: string;
  journey?: string;
  title?: string;
  media?: string[];
  force?: boolean;
}

export async function newAsset(rawName: string, options: NewAssetOptions = {}): Promise<Outcome<{asset: string; dir: string; files: string[]; template: string; width: number; height: number}>> {
  const project = await loadProject();
  const name = slugify(rawName);
  const template = options.template ?? (options.journey ? 'product-walkthrough' : 'feature-highlight');
  if (!TEMPLATES.some((t) => t.id === template)) throw new StudioError(`Unknown template "${template}".`, `Use one of: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  const format = resolveFormat(options.format);
  const dir = assetDir(project, name);
  if (existsSync(path.join(dir, 'scene.html')) && !options.force) {
    throw new StudioError(`Asset "${name}" already exists.`, 'Pick another name, or pass --force to overwrite scene.html (notes and versions are kept).');
  }
  await mkdir(path.join(dir, 'media'), {recursive: true});

  const inventory = await readJson<Inventory | null>(path.join(project.stateDir, 'inventory.json'), null);
  const journey = options.journey ? await getJourney(project, options.journey) : null;
  if (template === 'product-walkthrough' && !journey) throw new StudioError('product-walkthrough needs --journey <id>.', 'Run gif-studio journeys list, or pick another template.');
  const captures = journey ? capturesDir(project, journey.id) : null;
  const hasPlates = captures ? existsSync(path.join(captures, 'plates.json')) : false;

  const media: string[] = [];
  const sources = [...(options.media ?? [])];
  if (!sources.length && inventory) {
    const logo = inventory.brand.logos.find((l) => /\.(svg|png)$/i.test(l));
    if (logo) sources.push(path.join(inventory.root, logo));
    for (const shot of inventory.content.screenshots.slice(0, 4)) sources.push(path.join(inventory.root, shot));
  }
  for (const source of sources) {
    const absolute = path.resolve(project.root, source);
    if (!existsSync(absolute)) continue;
    const target = path.join(dir, 'media', path.basename(absolute));
    await copyFile(absolute, target);
    media.push(`media/${path.basename(absolute)}`);
  }

  const {primary, accent} = pickPrimary(inventory);
  const title = options.title ?? journey?.title ?? inventory?.name ?? name;
  const values: Record<string, string> = {
    TITLE: title,
    WIDTH: String(format.width),
    HEIGHT: String(format.height),
    PRIMARY: primary,
    ACCENT: accent,
    FONT: inventory?.brand.fonts[0] ? `'${inventory.brand.fonts[0]}', system-ui, sans-serif` : 'system-ui, -apple-system, sans-serif',
    CAPTURE: journey ? `../captures/${journey.id}/` : '',
    MEDIA: JSON.stringify(media),
    LOGO: media.find((m) => /logo|brand|mark|favicon/i.test(m)) ?? '',
    PITCH: (inventory?.pitch ?? '').split('\n')[0]!.slice(0, 140).replace(/"/g, '&quot;'),
  };

  const templateDir = path.join(packageRoot(), 'templates', template);
  const scene = fill(await readFile(path.join(templateDir, 'scene.html'), 'utf8'), values);
  await writeFile(path.join(dir, 'scene.html'), scene);

  const brief = fill(await readFile(path.join(packageRoot(), 'templates', 'brief.md'), 'utf8'), {
    ...values,
    ASSET: name,
    TEMPLATE: template,
    FORMAT: `${format.id} (${format.width}x${format.height} CSS px)`,
    JOURNEY: journey ? `${journey.id}: ${journey.title}\n\n${journey.steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join('\n')}` : 'None',
    MEDIA_LIST: media.length ? media.map((m) => `- ${m}`).join('\n') : '- (none yet: gif-studio media add <asset> <files…>)',
    PITCH_FULL: inventory?.pitch ?? '(no pitch found)',
  });
  if (!existsSync(path.join(dir, 'brief.md')) || options.force) await writeFile(path.join(dir, 'brief.md'), brief);
  if (!existsSync(path.join(dir, 'notes.json'))) await writeNotes(project, name, []);
  if (!existsSync(path.join(dir, 'pacing.json'))) await writePacing(project, name, {});

  const next: string[] = [];
  if (journey && !hasPlates) next.push(`gif-studio record ${journey.id}  # plates are missing`);
  next.push(`Fill in ${relative(project, dir)}/brief.md copy and adapt scene.html`, `gif-studio render ${name}`, 'gif-studio studio');
  return outcome(
    {asset: name, dir: relative(project, dir), files: ['scene.html', 'brief.md', 'notes.json', 'pacing.json', ...media], template, width: format.width, height: format.height},
    `Created ${relative(project, dir)} from "${template}" at ${format.width}x${format.height}${media.length ? ` with ${media.length} media file(s)` : ''}.`,
    next,
  );
}

export async function addMedia(name: string, files: string[]): Promise<Outcome<string[]>> {
  const project = await loadProject();
  const dir = await requireAsset(project, name);
  await mkdir(path.join(dir, 'media'), {recursive: true});
  const added: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(project.root, file);
    if (!existsSync(absolute)) throw new StudioError(`File not found: ${file}`);
    await cp(absolute, path.join(dir, 'media', path.basename(absolute)), {recursive: true});
    added.push(`media/${path.basename(absolute)}`);
  }
  return outcome(added, `Added ${added.length} file(s) to ${relative(project, dir)}/media. Reference them in scene.html as ${added[0] ?? 'media/<file>'}.`);
}

export async function promote(name: string, version: string | number): Promise<Outcome<{final: string[]; archived: string[]}>> {
  const project = await loadProject();
  const dir = await requireAsset(project, name);
  const n = parseVersion(version);
  if (n === null) throw new StudioError(`Invalid version "${version}". Use vN.`);
  const versions = await listVersions(project, name);
  const chosen = versions.find((v) => v.n === n && !v.archived);
  if (!chosen) throw new StudioError(`Version v${n} not found in ${name}/versions.`, `Available: ${versions.filter((v) => !v.archived).map((v) => v.label).join(', ') || 'none'}`);
  if (!chosen.outputs.length) throw new StudioError(`v${n} has no exports yet.`, `gif-studio render ${name} --version v${n}`);

  const finalDir = path.join(dir, 'final');
  await rm(finalDir, {recursive: true, force: true});
  await mkdir(finalDir, {recursive: true});
  const final: string[] = [];
  for (const output of chosen.outputs) {
    const target = path.join(finalDir, `${name}.${output.format}`);
    await copyFile(path.join(project.root, output.file), target);
    final.push(relative(project, target));
  }
  const stills = path.join(project.root, chosen.dir, 'stills');
  if (existsSync(stills)) {
    await cp(stills, path.join(finalDir, 'stills'), {recursive: true});
    final.push(relative(project, path.join(finalDir, 'stills')));
  }
  await writeJson(path.join(finalDir, 'meta.json'), {asset: name, version: n, durationMs: chosen.durationMs, promotedAt: new Date().toISOString()});

  const archived: string[] = [];
  const archiveDir = path.join(dir, 'archive');
  for (const older of versions.filter((v) => !v.archived && v.n < n)) {
    await mkdir(archiveDir, {recursive: true});
    await rename(path.join(project.root, older.dir), path.join(archiveDir, older.label));
    for (const output of older.outputs) await rename(path.join(project.root, output.file), path.join(archiveDir, path.basename(output.file)));
    archived.push(older.label);
  }
  return outcome({final, archived}, `Promoted ${name} v${n} to ${relative(project, finalDir)}${archived.length ? `; archived ${archived.join(', ')}` : ''}.`, ['Hand final/ to engineering or marketing: GIF is the master, MP4 is for the product']);
}

export async function assetSummary(project: Project, name: string) {
  const versions = await listVersions(project, name);
  const notes = withStatus(await readNotes(project, name), versions.map((v) => v.n));
  return {
    asset: name,
    versions: versions.map((v) => ({label: v.label, archived: v.archived, durationMs: v.durationMs, outputs: v.outputs.map((o) => o.file)})),
    latest: versions.filter((v) => !v.archived).at(-1)?.label ?? null,
    openNotes: notes.filter((n) => n.open).length,
    final: existsSync(path.join(assetDir(project, name), 'final', 'meta.json')),
  };
}
