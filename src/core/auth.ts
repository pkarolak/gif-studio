import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {resolveAppUrl} from './app.js';
import {authStatePath, launchBrowser} from './browser.js';
import {outcome, type Outcome} from './outcome.js';
import {loadProject} from './project.js';

export interface AuthLoginOptions {
  url?: string;
  name?: string;
  timeoutMs?: number;
}

export async function authLogin(options: AuthLoginOptions = {}): Promise<Outcome<{name: string; file: string}>> {
  const project = await loadProject();
  const name = options.name ?? project.config.auth ?? 'default';
  const file = authStatePath(project, name);
  await mkdir(path.dirname(file), {recursive: true});
  const url = await resolveAppUrl(project, options.url ?? '/');

  const browser = await launchBrowser({headless: false});
  const context = await browser.newContext({viewport: project.config.viewport});
  const page = await context.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded'});

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let saved = false;
  while (browser.isConnected() && Date.now() < deadline && context.pages().length > 0) {
    try {
      await context.storageState({path: file});
      saved = true;
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await browser.close().catch(() => undefined);

  return outcome(
    {name, file},
    saved
      ? `Saved login session "${name}" to ${path.relative(project.root, file)}. Browser sessions, explore and record now reuse it.`
      : 'Login window closed before any session state was saved.',
    ['gif-studio explore'],
  );
}
