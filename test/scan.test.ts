import {afterEach, describe, expect, it} from 'vitest';
import {extractBrand, extractPitch, extractSeedAccounts, scanLocation} from '../src/core/scan.js';
import {PNG_1x1, tempDir, writeFiles} from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

function fixture(files: Record<string, string | Buffer>): string {
  const temp = tempDir('gif-studio-scan-');
  cleanup = temp.cleanup;
  writeFiles(temp.dir, files);
  return temp.dir;
}

describe('scan', () => {
  it('detects a Next.js app with routes, brand and seed accounts', async () => {
    const root = fixture({
      'package.json': JSON.stringify({name: 'acme', scripts: {dev: 'next dev'}, dependencies: {next: '15.0.0', react: '19.0.0'}}),
      'pnpm-lock.yaml': '',
      'README.md': '# Acme\n\nAcme helps teams ship onboarding flows in minutes.\n\nDemo login: demo@acme.dev / demo1234\n',
      'app/page.tsx': 'export default function Page() { return null }',
      'app/dashboard/page.tsx': 'export default function Page() { return null }',
      'app/settings/[tab]/page.tsx': 'export default function Page() { return null }',
      'app/globals.css': ':root { --brand-primary: #4262ff; --brand-accent: #ffd02f; } body { font-family: "Inter", sans-serif; color: #4262ff; }',
      'public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>',
    });
    const inventory = await scanLocation(root);
    expect(inventory.kind).toBe('app');
    expect(inventory.name).toBe('Acme');
    expect(inventory.app).toMatchObject({framework: 'next', packageManager: 'pnpm', port: 3000});
    expect(inventory.app!.devCommand).toContain('dev');
    expect(inventory.app!.routes).toEqual(expect.arrayContaining(['/', '/dashboard']));
    expect(inventory.brand.cssVariables.map((v) => v.name)).toContain('--brand-primary');
    expect(inventory.brand.fonts).toContain('Inter');
    expect(inventory.brand.logos.some((l) => l.endsWith('logo.svg'))).toBe(true);
    expect(inventory.seedAccounts.some((a) => a.email === 'demo@acme.dev')).toBe(true);
  });

  it('detects a Vite app', async () => {
    const root = fixture({
      'package.json': JSON.stringify({name: 'v', scripts: {dev: 'vite'}, devDependencies: {vite: '7.0.0'}}),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/main.ts': 'console.log(1)',
    });
    const inventory = await scanLocation(root);
    expect(inventory.kind).toBe('app');
    expect(inventory.app).toMatchObject({framework: 'vite', port: 5173});
  });

  it('classifies a folder of images as an asset folder', async () => {
    const root = fixture({'shots/dashboard.png': PNG_1x1, 'shots/editor.png': PNG_1x1, 'brand/logo.png': PNG_1x1});
    const inventory = await scanLocation(root);
    expect(inventory.kind).toBe('asset-folder');
    expect(inventory.app).toBeNull();
    expect(inventory.content.images).toHaveLength(3);
    expect(inventory.content.images[0]).toMatchObject({width: 1, height: 1});
  });

  it('classifies an empty folder', async () => {
    expect((await scanLocation(fixture({}))).kind).toBe('empty');
  });

  it('classifies a static site', async () => {
    const root = fixture({'index.html': '<!doctype html><title>Site</title>', 'about.html': '<p>About</p>', 'styles.css': 'body{}'});
    expect((await scanLocation(root)).kind).toBe('static-site');
  });
});

describe('extractors', () => {
  it('pulls the name and first paragraph from a README', () => {
    expect(extractPitch('# Plannr\n\n![badge](x.svg)\n\nPlan the work, share it with your team.\n')).toEqual({name: 'Plannr', pitch: expect.stringContaining('Plan the work')});
  });

  it('ranks brand colors by use', () => {
    const brand = extractBrand([':root{--primary:#ff0066} a{color:#ff0066} b{color:#00ff00}']);
    expect(brand.colors[0]!.value.toLowerCase()).toBe('#ff0066');
  });

  it('finds seed credentials', () => {
    const accounts = extractSeedAccounts([{file: 'seed.ts', text: "createUser({email: 'admin@example.com', password: 'secret123'})"}]);
    expect(accounts[0]).toMatchObject({email: 'admin@example.com'});
  });
});
