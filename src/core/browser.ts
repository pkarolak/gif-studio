import {existsSync} from 'node:fs';
import path from 'node:path';
import {chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page} from 'playwright-core';
import {resolveAppUrl} from './app.js';
import {StudioError} from './outcome.js';
import type {Project} from './project.js';

export type Target =
  | string
  | {
      selector?: string;
      text?: string;
      role?: string;
      name?: string;
      label?: string;
      placeholder?: string;
      testId?: string;
      exact?: boolean;
      nth?: number;
    };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InteractiveElement {
  role: string;
  name: string;
  tag: string;
  box: Box;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  interactive: InteractiveElement[];
  aria: string;
}

export async function launchBrowser(options: {headless?: boolean} = {}): Promise<Browser> {
  const headless = options.headless ?? true;
  const errors: string[] = [];
  const executablePath = process.env.GIF_STUDIO_CHROME;
  if (executablePath) return chromium.launch({headless, executablePath});
  for (const attempt of [{channel: 'chrome'}, {channel: 'msedge'}, {}] as const) {
    try {
      return await chromium.launch({headless, ...attempt});
    } catch (error) {
      errors.push((error as Error).message.split('\n')[0]!);
    }
  }
  throw new StudioError(
    `Could not launch a Chromium browser.\n${errors.join('\n')}`,
    'Install Google Chrome, run "npx playwright install chromium", or set GIF_STUDIO_CHROME to a Chromium executable.',
  );
}

export function authStatePath(project: Project, name: string): string {
  return path.join(project.stateDir, 'auth', `${name}.json`);
}

export function contextOptions(project: Project, overrides: BrowserContextOptions & {auth?: string | false} = {}): BrowserContextOptions {
  const {auth, ...rest} = overrides;
  const authName = auth === false ? undefined : (auth ?? project.config.auth ?? 'default');
  const storage = authName ? authStatePath(project, authName) : undefined;
  return {
    viewport: project.config.viewport,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    ...(storage && existsSync(storage) ? {storageState: storage} : {}),
    ...rest,
  };
}

export function locate(page: Page, target: Target): Locator {
  if (typeof target === 'string') {
    const looksLikeSelector = /^[#.[]|^\w+\[|>>|^(css|xpath|text|role)=|^\/\//.test(target);
    return (looksLikeSelector ? page.locator(target) : page.getByText(target)).first();
  }
  const exact = target.exact ?? false;
  let locator: Locator;
  if (target.selector) locator = page.locator(target.selector);
  else if (target.testId) locator = page.getByTestId(target.testId);
  else if (target.role) locator = page.getByRole(target.role as Parameters<Page['getByRole']>[0], target.name ? {name: target.name, exact} : {});
  else if (target.label) locator = page.getByLabel(target.label, {exact});
  else if (target.placeholder) locator = page.getByPlaceholder(target.placeholder, {exact});
  else if (target.text) locator = page.getByText(target.text, {exact});
  else throw new StudioError(`Empty target: ${JSON.stringify(target)}`, 'Use selector, text, role+name, label, placeholder or testId.');
  return target.nth !== undefined ? locator.nth(target.nth) : locator.first();
}

export function describeTarget(target: Target): string {
  if (typeof target === 'string') return target;
  return Object.entries(target)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
}

export async function settle(page: Page, ms = 350): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForLoadState('networkidle', {timeout: 4000}).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page.waitForTimeout(ms);
}

export async function applyMasks(page: Page, project: Project): Promise<void> {
  const {mask, replace} = project.config;
  if (!mask.length && !Object.keys(replace).length) return;
  await page
    .evaluate(
      ({mask, replace}) => {
        let style = document.getElementById('__gif_studio_mask') as HTMLStyleElement | null;
        if (!style) {
          style = document.createElement('style');
          style.id = '__gif_studio_mask';
          document.head.appendChild(style);
        }
        style.textContent = mask.length ? `${mask.join(',')}{filter:blur(8px) !important;}` : '';
        for (const [selector, text] of Object.entries(replace)) {
          document.querySelectorAll(selector).forEach((el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = text;
            else el.textContent = text;
          });
        }
      },
      {mask, replace},
    )
    .catch(() => undefined);
}

export async function snapshotPage(page: Page, options: {ariaLimit?: number; interactiveLimit?: number} = {}): Promise<PageSnapshot> {
  const data = await page.evaluate((limit) => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const nameOf = (el: Element) => {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt');
      const text = (el as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
      const value = el instanceof HTMLInputElement ? el.value : '';
      return (aria || text || value || '').slice(0, 80);
    };
    const roleOf = (el: Element) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      if ((el as HTMLElement).isContentEditable) return 'textbox';
      return tag;
    };
    const selector =
      'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[contenteditable=true]';
    const interactive = [...document.querySelectorAll(selector)]
      .filter(visible)
      .slice(0, limit)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          role: roleOf(el),
          name: nameOf(el),
          tag: el.tagName.toLowerCase(),
          box: {x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height)},
          ...(el instanceof HTMLAnchorElement ? {href: el.href} : {}),
        };
      });
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .filter(visible)
      .slice(0, 20)
      .map((h) => `${h.tagName.toLowerCase()}: ${(h as HTMLElement).innerText.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
    return {url: location.href, title: document.title, headings, interactive};
  }, options.interactiveLimit ?? 120);
  let aria = '';
  try {
    aria = await page.locator('body').ariaSnapshot({timeout: 5000});
  } catch {
    aria = '';
  }
  const limit = options.ariaLimit ?? 6000;
  return {...data, aria: aria.length > limit ? `${aria.slice(0, limit)}\n… (truncated)` : aria};
}

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly project: Project) {}

  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser ??= await launchBrowser();
    this.context = await this.browser.newContext(contextOptions(this.project));
    this.page = await this.context.newPage();
    return this.page;
  }

  get currentUrl(): string | null {
    return this.page && !this.page.isClosed() ? this.page.url() : null;
  }

  async open(target: string): Promise<Page> {
    const page = await this.ensurePage();
    const url = await resolveAppUrl(this.project, target);
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60_000});
    await settle(page);
    return page;
  }

  async click(target: Target): Promise<Page> {
    const page = await this.ensurePage();
    await locate(page, target).click({timeout: 10_000});
    await settle(page);
    return page;
  }

  async type(target: Target, text: string, options: {submit?: boolean; clear?: boolean} = {}): Promise<Page> {
    const page = await this.ensurePage();
    const locator = locate(page, target);
    if (options.clear ?? true) await locator.fill('', {timeout: 10_000});
    await locator.pressSequentially(text, {delay: 15});
    if (options.submit) await locator.press('Enter');
    await settle(page);
    return page;
  }

  async press(key: string): Promise<Page> {
    const page = await this.ensurePage();
    await page.keyboard.press(key);
    await settle(page);
    return page;
  }

  async hover(target: Target): Promise<Page> {
    const page = await this.ensurePage();
    await locate(page, target).hover({timeout: 10_000});
    await page.waitForTimeout(250);
    return page;
  }

  async scroll(options: {to?: Target; y?: number}): Promise<Page> {
    const page = await this.ensurePage();
    if (options.to) await locate(page, options.to).scrollIntoViewIfNeeded({timeout: 10_000});
    else await page.mouse.wheel(0, options.y ?? 600);
    await page.waitForTimeout(400);
    return page;
  }

  async screenshot(options: {fullPage?: boolean; path?: string; type?: 'png' | 'jpeg'} = {}): Promise<Buffer> {
    const page = await this.ensurePage();
    await applyMasks(page, this.project);
    const type = options.type ?? 'png';
    return page.screenshot({fullPage: options.fullPage ?? false, type, ...(type === 'jpeg' ? {quality: 72} : {}), ...(options.path ? {path: options.path} : {})});
  }

  async snapshot(): Promise<PageSnapshot> {
    return snapshotPage(await this.ensurePage());
  }

  async links(): Promise<Array<{text: string; href: string}>> {
    const page = await this.ensurePage();
    return page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => ({text: (a as HTMLElement).innerText.trim().replace(/\s+/g, ' ').slice(0, 80), href: (a as HTMLAnchorElement).href}))
        .filter((l, i, all) => l.href.startsWith('http') && all.findIndex((x) => x.href === l.href) === i)
        .slice(0, 200),
    );
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
