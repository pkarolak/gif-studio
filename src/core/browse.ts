import path from 'node:path';
import {BrowserSession, describeTarget, type PageSnapshot, type Target} from './browser.js';
import {outcome, StudioError, type Outcome} from './outcome.js';
import {ensureStateDir, loadProject, readJson, relative, writeJson, type Project} from './project.js';

export type BrowseAction =
  | {action: 'open'; url: string}
  | {action: 'click'; target: Target}
  | {action: 'type'; target: Target; text: string; submit?: boolean}
  | {action: 'press'; key: string}
  | {action: 'hover'; target: Target}
  | {action: 'scroll'; to?: Target; y?: number}
  | {action: 'screenshot'; url?: string; fullPage?: boolean}
  | {action: 'snapshot'; url?: string}
  | {action: 'links'; url?: string};

export interface BrowseResult {
  url: string;
  screenshot: string | null;
  screenshotAbsolute: string | null;
  snapshot?: PageSnapshot;
  links?: Array<{text: string; href: string}>;
}

const sessionFile = (project: Project) => path.join(project.stateDir, 'session.json');

export async function browse(
  request: BrowseAction,
  options: {session?: BrowserSession; screenshot?: boolean; imageType?: 'png' | 'jpeg'} = {},
): Promise<Outcome<BrowseResult> & {image?: Buffer}> {
  const project = await loadProject();
  const ownsSession = !options.session;
  const session = options.session ?? new BrowserSession(project);
  try {
    const remembered = await readJson<{url?: string}>(sessionFile(project), {});
    const targetUrl = 'url' in request && request.url ? request.url : undefined;
    if (request.action === 'open') {
      await session.open(request.url);
    } else if (targetUrl) {
      await session.open(targetUrl);
    } else if (!session.currentUrl || session.currentUrl === 'about:blank') {
      if (!remembered.url) throw new StudioError('No page open yet.', 'Start with: gif-studio browse open /');
      await session.open(remembered.url);
    }

    let summary = '';
    const result: BrowseResult = {url: '', screenshot: null, screenshotAbsolute: null};
    switch (request.action) {
      case 'click':
        await session.click(request.target);
        summary = `Clicked ${describeTarget(request.target)}`;
        break;
      case 'type':
        await session.type(request.target, request.text, {submit: request.submit});
        summary = `Typed into ${describeTarget(request.target)}`;
        break;
      case 'press':
        await session.press(request.key);
        summary = `Pressed ${request.key}`;
        break;
      case 'hover':
        await session.hover(request.target);
        summary = `Hovered ${describeTarget(request.target)}`;
        break;
      case 'scroll':
        await session.scroll({to: request.to, y: request.y});
        summary = 'Scrolled';
        break;
      case 'snapshot':
        result.snapshot = await session.snapshot();
        summary = `Snapshot: ${result.snapshot.title} — ${result.snapshot.interactive.length} interactive elements`;
        break;
      case 'links':
        result.links = await session.links();
        summary = `${result.links.length} links`;
        break;
      default:
        summary = 'Opened';
    }

    result.url = session.currentUrl ?? '';
    await writeJson(sessionFile(project), {url: result.url});

    let image: Buffer | undefined;
    const wantsShot = options.screenshot ?? !['snapshot', 'links'].includes(request.action);
    if (wantsShot) {
      const dir = await ensureStateDir(project, 'shots');
      const type = options.imageType ?? 'png';
      const file = path.join(dir, `${Date.now()}.${type === 'jpeg' ? 'jpg' : 'png'}`);
      image = await session.screenshot({path: file, type, fullPage: request.action === 'screenshot' && request.fullPage});
      result.screenshot = relative(project, file);
      result.screenshotAbsolute = file;
    }
    return {
      ...outcome(result, `${summary} at ${result.url}${result.screenshot ? `\nScreenshot: ${result.screenshot}` : ''}`, [
        'gif-studio browse snapshot  # list clickable elements with boxes',
        'Add the steps that worked to marketing/gifs/journeys.json',
      ]),
      image,
    };
  } finally {
    if (ownsSession) await session.close();
  }
}
