import path from 'node:path';
import {resolveAppUrl} from './app.js';
import {applyMasks, contextOptions, launchBrowser, settle, snapshotPage, type InteractiveElement} from './browser.js';
import type {Journey} from './journeys.js';
import {outcome, type Outcome} from './outcome.js';
import {ensureStateDir, loadProject, readJson, relative, slugify, writeJson} from './project.js';
import type {Inventory} from './scan.js';

export interface ExploredPage {
  url: string;
  path: string;
  title: string;
  depth: number;
  screenshot: string;
  headings: string[];
  primaryActions: Array<{role: string; name: string}>;
  inputs: Array<{role: string; name: string}>;
  links: string[];
  redirectedToLogin: boolean;
}

export interface Sitemap {
  startUrl: string;
  exploredAt: string;
  pages: ExploredPage[];
  suggestedJourneys: Journey[];
}

const ACTION_WORDS = /\b(create|new|add|start|try|get started|sign up|upload|import|generate|build|share|invite|export|publish|save|send|search|compose|connect|book|buy|checkout|subscribe|run|ask)\b/i;
const LOGIN_HINT = /\b(log ?in|sign ?in|password)\b/i;

export interface ExploreOptions {
  start?: string;
  maxPages?: number;
  maxDepth?: number;
}

function isPrimaryAction(el: InteractiveElement): boolean {
  return (el.role === 'button' || el.role === 'link') && el.name.length > 1 && el.name.length < 40 && ACTION_WORDS.test(el.name);
}

export function suggestJourneys(pages: ExploredPage[]): Journey[] {
  const frequency = new Map<string, number>();
  for (const page of pages) for (const action of page.primaryActions) frequency.set(action.name, (frequency.get(action.name) ?? 0) + 1);

  const suggestions: Journey[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (page.redirectedToLogin) continue;
    for (const action of page.primaryActions.slice(0, 4)) {
      const key = action.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pageWeight = 1 / (1 + page.depth);
      const globalWeight = Math.min(frequency.get(action.name) ?? 1, 5) / 5;
      const inputStep = page.inputs.find((i) => i.role === 'textbox' && i.name);
      const steps: Journey['steps'] = [{goto: page.path, beat: page.title || page.path}];
      if (inputStep && /search|ask|prompt|message|name|title/i.test(inputStep.name)) {
        steps.push({type: {label: inputStep.name, text: '…', human: true}, beat: `Type in ${inputStep.name}`});
      }
      steps.push({click: {role: action.role, name: action.name}, beat: action.name});
      steps.push({capture: 'result', beat: 'Result'});
      suggestions.push({
        id: slugify(`${action.name}-${page.path === '/' ? 'home' : page.path}`),
        title: action.name,
        why: `"${action.name}" ${action.role} on ${page.path}${(frequency.get(action.name) ?? 0) > 1 ? `, present on ${frequency.get(action.name)} pages` : ''}`,
        score: Math.round((pageWeight * 0.6 + globalWeight * 0.4) * 100) / 100,
        steps,
      });
    }
  }
  return suggestions.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
}

export async function explore(options: ExploreOptions = {}): Promise<Outcome<Sitemap>> {
  const project = await loadProject();
  const startUrl = await resolveAppUrl(project, options.start ?? '/');
  const origin = new URL(startUrl).origin;
  const maxPages = options.maxPages ?? 20;
  const maxDepth = options.maxDepth ?? 2;
  const dir = await ensureStateDir(project, 'explore');
  const inventory = await readJson<Inventory | null>(path.join(project.stateDir, 'inventory.json'), null);

  const queue: Array<{url: string; depth: number}> = [{url: startUrl, depth: 0}];
  for (const route of inventory?.app?.routes ?? []) {
    if (!/[:\[$*]/.test(route)) queue.push({url: new URL(route, origin).toString(), depth: 1});
  }
  const visited = new Set<string>();
  const pages: ExploredPage[] = [];

  const browser = await launchBrowser();
  const context = await browser.newContext(contextOptions(project));
  const page = await context.newPage();
  try {
    while (queue.length && pages.length < maxPages) {
      const {url, depth} = queue.shift()!;
      const key = url.split('#')[0]!.replace(/\/$/, '');
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30_000});
      } catch {
        continue;
      }
      await settle(page, 500);
      const finalUrl = new URL(page.url());
      if (finalUrl.origin !== origin) continue;
      visited.add(finalUrl.toString().split('#')[0]!.replace(/\/$/, ''));
      await applyMasks(page, project);
      const snapshot = await snapshotPage(page, {ariaLimit: 1500});
      const file = path.join(dir, `${String(pages.length).padStart(2, '0')}-${slugify(finalUrl.pathname === '/' ? 'home' : finalUrl.pathname)}.png`);
      await page.screenshot({path: file});

      const links = snapshot.interactive
        .filter((el) => el.href && el.href.startsWith(origin))
        .map((el) => el.href!.split('#')[0]!)
        .filter((href, i, all) => all.indexOf(href) === i);
      const hasPassword = await page.locator('input[type=password]').count().catch(() => 0);
      pages.push({
        url: finalUrl.toString(),
        path: finalUrl.pathname + finalUrl.search,
        title: snapshot.title,
        depth,
        screenshot: relative(project, file),
        headings: snapshot.headings,
        primaryActions: snapshot.interactive.filter(isPrimaryAction).map(({role, name}) => ({role, name})).slice(0, 10),
        inputs: snapshot.interactive.filter((el) => el.role === 'textbox' || el.role === 'combobox').map(({role, name}) => ({role, name})).slice(0, 10),
        links: links.slice(0, 40),
        redirectedToLogin: hasPassword > 0 && LOGIN_HINT.test(`${snapshot.title} ${snapshot.headings.join(' ')}`),
      });
      if (depth < maxDepth) for (const link of links) queue.push({url: link, depth: depth + 1});
    }
  } finally {
    await browser.close();
  }

  const sitemap: Sitemap = {startUrl, exploredAt: new Date().toISOString(), pages, suggestedJourneys: suggestJourneys(pages)};
  await writeJson(path.join(dir, 'sitemap.json'), sitemap);

  const loginPages = pages.filter((p) => p.redirectedToLogin);
  const summary = [
    `Explored ${pages.length} page(s) from ${startUrl}. Sitemap: .gif-studio/explore/sitemap.json`,
    ...pages.map((p) => `  ${p.path} — ${p.title || 'untitled'}${p.primaryActions.length ? ` [${p.primaryActions.map((a) => a.name).join(', ')}]` : ''}${p.redirectedToLogin ? ' (LOGIN)' : ''}`),
    loginPages.length ? `${loginPages.length} page(s) look like a login wall.` : '',
    `Suggested journeys: ${sitemap.suggestedJourneys.map((j) => j.id).join(', ') || 'none'}`,
  ]
    .filter(Boolean)
    .join('\n');

  const next = [
    'Look at the screenshots in .gif-studio/explore/, then propose the top 2-4 journeys to the user',
    'gif-studio journeys save <file.json>  # after the user approves',
  ];
  if (loginPages.length) next.unshift('gif-studio auth login /  # ask the user to log in once, then explore again');
  return outcome(sitemap, summary, next);
}
