import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  listVersions,
  newAsset,
  nextVersion,
  notesFor,
  outputName,
  parseVersion,
  promote,
  readNotes,
  resolveNote,
  setPacing,
  snapshotScene,
  withStatus,
  writeNotes,
  type Note,
} from '../src/core/assets.js';
import {loadProject} from '../src/core/project.js';
import {PNG_1x1, tempProject} from './helpers.js';

let project: {dir: string; cleanup(): void};
beforeEach(() => {
  project = tempProject();
});
afterEach(() => project.cleanup());

const note = (overrides: Partial<Note>): Note => ({
  id: 'n1',
  version: 1,
  t: 1000,
  x: 0.5,
  y: 0.5,
  text: 'Hold longer',
  attachments: [],
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('versions', () => {
  it('parses version labels', () => {
    expect(parseVersion('v3')).toBe(3);
    expect(parseVersion('3')).toBe(3);
    expect(parseVersion(4)).toBe(4);
    expect(parseVersion(undefined)).toBeNull();
    expect(outputName('hero', 2, 6400, 'gif')).toBe('hero-v2-6.4s.gif');
  });

  it('creates an asset from a template and snapshots versions with a base href', async () => {
    const created = await newAsset('Hero Loop', {template: 'synthetic', format: '1:1', title: 'Make it'});
    expect(created.data).toMatchObject({asset: 'hero-loop', width: 720, height: 720});
    const p = await loadProject();
    const scene = readFileSync(path.join(p.assetsDir, 'hero-loop', 'scene.html'), 'utf8');
    expect(scene).toContain('const W = 720, H = 720');
    expect(scene).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(await nextVersion(p, 'hero-loop')).toBe(1);

    const snapshot = await snapshotScene(p, 'hero-loop', 1);
    expect(readFileSync(path.join(snapshot, 'scene.html'), 'utf8')).toContain('<base href="../../">');
    expect(await nextVersion(p, 'hero-loop')).toBe(2);
    expect((await listVersions(p, 'hero-loop')).map((v) => v.label)).toEqual(['v1']);
  });

  it('refuses to overwrite without force and requires a journey for walkthroughs', async () => {
    await newAsset('a', {template: 'synthetic'});
    await expect(newAsset('a', {template: 'synthetic'})).rejects.toThrow(/already exists/);
    await expect(newAsset('b', {template: 'product-walkthrough'})).rejects.toThrow(/journey/);
  });

  it('copies media into the asset', async () => {
    await writeFile(path.join(project.dir, 'shot.png'), PNG_1x1);
    const created = await newAsset('m', {template: 'feature-highlight', media: ['shot.png']});
    expect(created.data.files).toContain('media/shot.png');
    const p = await loadProject();
    expect(readFileSync(path.join(p.assetsDir, 'm', 'scene.html'), 'utf8')).toContain('"media/shot.png"');
  });

  it('promotes a version to final and archives older ones', async () => {
    await newAsset('p', {template: 'synthetic'});
    const p = await loadProject();
    for (const n of [1, 2]) {
      await snapshotScene(p, 'p', n);
      const versions = path.join(p.assetsDir, 'p', 'versions');
      await writeFile(path.join(versions, `p-v${n}-5.0s.gif`), 'gif');
      await writeFile(path.join(versions, `p-v${n}-5.0s.mp4`), 'mp4');
      await mkdir(path.join(versions, `v${n}`, 'stills'), {recursive: true});
      await writeFile(path.join(versions, `v${n}`, 'meta.json'), JSON.stringify({durationMs: 5000}));
    }
    const result = await promote('p', 'v2');
    const dir = path.join(p.assetsDir, 'p');
    expect(existsSync(path.join(dir, 'final', 'p.gif'))).toBe(true);
    expect(existsSync(path.join(dir, 'final', 'p.mp4'))).toBe(true);
    expect(result.data.archived).toContain('v1');
    expect(existsSync(path.join(dir, 'archive', 'v1'))).toBe(true);
    const versions = await listVersions(p, 'p');
    expect(versions.find((v) => v.n === 1)?.archived).toBe(true);
    expect(versions.find((v) => v.n === 2)?.archived).toBe(false);
  });
});

describe('notes', () => {
  it('marks notes covered once a newer version exists', () => {
    const notes = [note({id: 'a', version: 1}), note({id: 'b', version: 2}), note({id: 'c', version: 1, done: true})];
    const status = withStatus(notes, [1, 2]);
    expect(status.find((n) => n.id === 'a')).toMatchObject({coveredIn: 2, open: false});
    expect(status.find((n) => n.id === 'b')).toMatchObject({coveredIn: null, open: true});
    expect(status.find((n) => n.id === 'c')).toMatchObject({open: false});
  });

  it('renders agent-readable markdown with ids and resolves notes', async () => {
    await newAsset('n', {template: 'synthetic'});
    const p = await loadProject();
    await writeNotes(p, 'n', [note({id: 'abc', t: 2500, text: 'Slower typing', attachments: ['notes-attachments/x.png']}), note({id: 'def', version: 2})]);
    const fromV1 = await notesFor('n', {version: 'v1'});
    expect(fromV1.data.notes.map((n) => n.id)).toEqual(['abc']);
    expect(fromV1.data.markdown).toContain('abc · 2.50s @ 50%,50%');
    expect(fromV1.data.markdown).toContain('attachment:');
    await resolveNote('n', 'abc');
    expect((await readNotes(p, 'n')).find((n) => n.id === 'abc')?.done).toBe(true);
    expect((await notesFor('n', {open: true})).data.notes.map((n) => n.id)).toEqual(['def']);
  });

  it('stores pacing speeds', async () => {
    await newAsset('s', {template: 'synthetic'});
    await setPacing('s', {intro: 1.5});
    const p = await loadProject();
    expect(JSON.parse(readFileSync(path.join(p.assetsDir, 's', 'pacing.json'), 'utf8')).speeds).toEqual({intro: 1.5});
  });
});
