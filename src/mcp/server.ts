import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {appStatus, startApp, stopApp} from '../core/app.js';
import {addMedia, newAsset, notesFor, promote, resolveNote, setPacing, TEMPLATES} from '../core/assets.js';
import {authLogin} from '../core/auth.js';
import {browse, type BrowseAction} from '../core/browse.js';
import {BrowserSession} from '../core/browser.js';
import {explore} from '../core/explore.js';
import {listJourneys, saveJourneys} from '../core/journeys.js';
import type {Outcome} from '../core/outcome.js';
import {loadProject, packageRoot} from '../core/project.js';
import {contactSheet, previewScene} from '../core/preview.js';
import {record} from '../core/record.js';
import {renderAsset} from '../core/render.js';
import {scan} from '../core/scan.js';
import {guide, init, status, templatesInfo} from '../core/setup.js';
import {ensureStudioRunning} from '../server/studio.js';

type Content = {type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string};

const MAX_JSON = 24_000;

function text(result: Outcome<unknown>, options: {data?: boolean} = {}): Content[] {
  const parts = [result.summary];
  if (result.next.length) parts.push(`Next:\n${result.next.map((n) => `- ${n}`).join('\n')}`);
  if (options.data ?? true) {
    const json = JSON.stringify(result.data, null, 1);
    parts.push(`Data:\n${json.length > MAX_JSON ? `${json.slice(0, MAX_JSON)}\n… (truncated; full data in the files listed above)` : json}`);
  }
  return [{type: 'text', text: parts.join('\n\n')}];
}

function image(buffer: Buffer, mimeType = 'image/jpeg'): Content {
  return {type: 'image', data: buffer.toString('base64'), mimeType};
}

async function wrap(fn: () => Promise<Content[]>) {
  try {
    return {content: await fn()};
  } catch (error) {
    const err = error as Error & {hint?: string};
    return {isError: true, content: [{type: 'text' as const, text: `Error: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}`}]};
  }
}

const targetSchema = z
  .union([
    z.string().describe('visible text, or a CSS selector starting with # . [ '),
    z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
      role: z.string().optional().describe('ARIA role, e.g. button, link, textbox, tab'),
      name: z.string().optional().describe('accessible name used with role'),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      testId: z.string().optional(),
      exact: z.boolean().optional(),
      nth: z.number().int().optional(),
    }),
  ])
  .describe('Element to act on. Prefer {role, name} taken from browser_snapshot.');

export function createMcpServer(): McpServer {
  const pkgVersion = (JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {version: string}).version;
  const server = new McpServer(
    {name: 'gif-studio', version: pkgVersion},
    {
      instructions:
        'gif-studio turns a repo, running app or folder of media into animated GIF + MP4 marketing assets. ALWAYS call `guide` first in a session, then `status`. Flow: scan → (app_start → explore → propose journeys → journeys_save → record) → asset_new → edit scene.html → scene_preview → render → studio_start (user leaves notes) → notes (apply them) → render → promote. Ask the user to approve journeys, formats and copy once before recording.',
    },
  );

  let session: BrowserSession | null = null;
  const getSession = async () => (session ??= new BrowserSession(await loadProject()));

  server.registerResource('guide', 'gif-studio://guide', {title: 'gif-studio agent playbook', mimeType: 'text/markdown'}, async (uri) => ({
    contents: [{uri: uri.href, mimeType: 'text/markdown', text: await readFile(path.join(packageRoot(), 'AGENTS.md'), 'utf8')}],
  }));

  server.registerTool('guide', {description: 'The agent playbook: workflow, decision tree, scene contract, runtime API, quality bar. Read before doing anything else.', annotations: {readOnlyHint: true}}, () =>
    wrap(async () => text(await guide(), {data: false})),
  );
  server.registerTool('status', {description: 'Current project state (inventory, app, journeys, recordings, assets, versions, open notes) and the recommended next steps. Use to resume work.', annotations: {readOnlyHint: true}}, () =>
    wrap(async () => text(await status())),
  );
  server.registerTool(
    'init',
    {description: 'Initialize gif-studio in the project root: config, marketing/gifs/, .gitignore, skill files and MCP registration. Safe to re-run.', inputSchema: {assetsDir: z.string().optional()}},
    ({assetsDir}) => wrap(async () => text(await init({assetsDir}))),
  );
  server.registerTool('templates', {description: 'Scene templates and format presets with when-to-use guidance.', annotations: {readOnlyHint: true}}, () => wrap(async () => text(templatesInfo())));
  server.registerTool(
    'scan',
    {description: 'Inventory a location (default: project root): kind (app/static-site/asset-folder/docs/mixed), framework, dev command, port, routes, brand colors/fonts/logos, images/videos, README pitch, seed/demo accounts. Writes .gif-studio/inventory.json.', inputSchema: {path: z.string().optional()}, annotations: {readOnlyHint: true}},
    ({path: target}) => wrap(async () => text(await scan(target))),
  );

  server.registerTool(
    'app_start',
    {
      description: 'Start the app (detected dev command) in the background and wait until reachable, or register an already running/deployed URL. Use static=true for plain HTML folders.',
      inputSchema: {command: z.string().optional(), url: z.string().optional(), cwd: z.string().optional(), static: z.boolean().optional(), timeoutSeconds: z.number().optional()},
    },
    (args) => wrap(async () => text(await startApp({...args, timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined}))),
  );
  server.registerTool('app_stop', {description: 'Stop the app started by gif-studio.'}, () => wrap(async () => text(await stopApp())));
  server.registerTool('app_status', {description: 'Is the app running and reachable.', annotations: {readOnlyHint: true}}, () => wrap(async () => text(await appStatus())));
  server.registerTool(
    'auth_login',
    {description: 'Open a VISIBLE browser so the USER can log in once; the session is saved and reused by browser, explore and record. Tell the user a window opened and to close it when logged in. Blocks until the window closes.', inputSchema: {url: z.string().optional(), name: z.string().optional()}},
    (args) => wrap(async () => text(await authLogin(args))),
  );

  const browseTool = (name: string, description: string, inputSchema: Record<string, z.ZodType>, toRequest: (args: Record<string, unknown>) => BrowseAction, readOnly = false) =>
    server.registerTool(name, {description, inputSchema, annotations: {readOnlyHint: readOnly}}, (args: Record<string, unknown>) =>
      wrap(async () => {
        const result = await browse(toRequest(args), {session: await getSession(), imageType: 'jpeg'});
        const content = text(result, {data: Boolean(result.data.snapshot || result.data.links)});
        if (result.image) content.push(image(result.image));
        return content;
      }),
    );
  browseTool('browser_open', 'Open a path (e.g. "/", "/pricing") on the running app, or a full URL. Returns a screenshot. The browser stays open between calls.', {url: z.string()}, (a) => ({action: 'open', url: a.url as string}));
  browseTool('browser_click', 'Click an element; returns the resulting screenshot.', {target: targetSchema}, (a) => ({action: 'click', target: a.target as never}));
  browseTool('browser_type', 'Type into a field; returns a screenshot.', {target: targetSchema, text: z.string(), submit: z.boolean().optional()}, (a) => ({action: 'type', target: a.target as never, text: a.text as string, submit: a.submit as boolean | undefined}));
  browseTool('browser_press', 'Press a key (Enter, Escape, Tab, Meta+K…).', {key: z.string()}, (a) => ({action: 'press', key: a.key as string}));
  browseTool('browser_hover', 'Hover an element.', {target: targetSchema}, (a) => ({action: 'hover', target: a.target as never}));
  browseTool('browser_scroll', 'Scroll by pixels or bring an element into view.', {to: targetSchema.optional(), y: z.number().optional()}, (a) => ({action: 'scroll', to: a.to as never, y: a.y as number | undefined}));
  browseTool('browser_screenshot', 'Screenshot the current page (or open url first).', {url: z.string().optional(), fullPage: z.boolean().optional()}, (a) => ({action: 'screenshot', url: a.url as string | undefined, fullPage: a.fullPage as boolean | undefined}), true);
  server.registerTool(
    'browser_snapshot',
    {description: 'Compact page model: title, headings, interactive elements with role, accessible name and box, plus the aria tree. Use it to pick {role, name} targets for journeys.', inputSchema: {url: z.string().optional()}, annotations: {readOnlyHint: true}},
    (args) => wrap(async () => text(await browse({action: 'snapshot', url: args.url}, {session: await getSession(), screenshot: false}))),
  );

  server.registerTool(
    'explore',
    {
      description: 'Crawl the running app breadth-first: screenshot + summary of every page, sitemap, login-wall detection and heuristic journey suggestions. Returns a contact sheet image of all pages. Afterwards, propose the 2-4 strongest journeys to the user.',
      inputSchema: {start: z.string().optional(), maxPages: z.number().int().optional(), maxDepth: z.number().int().optional()},
    },
    (args) =>
      wrap(async () => {
        const result = await explore(args);
        const project = await loadProject();
        const content = text(result);
        if (result.data.pages.length) {
          content.push(image(await contactSheet(result.data.pages.slice(0, 12).map((p) => ({label: `${p.path} — ${p.title}`, file: path.join(project.root, p.screenshot)})))));
        }
        return content;
      }),
  );
  server.registerTool('journeys_list', {description: 'Saved journeys (marketing/gifs/journeys.json).', annotations: {readOnlyHint: true}}, () => wrap(async () => text(await listJourneys())));
  server.registerTool(
    'journeys_save',
    {
      description:
        'Save journeys (merged by id). Step types: {goto:"/path"}, {click:target}, {hover:target}, {type:{label|placeholder|selector|target, text, submit?}}, {press:"Enter"}, {scroll:{to?|y?}}, {waitFor:target|{ms}}, {capture:"name"}. Any step may add beat (marker label), caption (on-screen text) and hold (ms to linger). Verify each step with browser_* first.',
      inputSchema: {journeys: z.array(z.record(z.string(), z.unknown())).describe('[{id, title, why?, viewport?, auth?, steps:[…]}]'), replace: z.boolean().optional()},
    },
    (args) => wrap(async () => text(await saveJourneys({journeys: args.journeys}, {replace: args.replace}))),
  );
  server.registerTool(
    'record',
    {
      description: 'Replay a journey headlessly. plates (default): hi-res screenshot per state + element boxes, ideal for crisp animated walkthroughs. footage: real screen recording, for live animations. Returns a contact sheet of the plates; check each state is correct before building a scene.',
      inputSchema: {journey: z.string(), mode: z.enum(['plates', 'footage', 'both']).optional(), scale: z.number().optional()},
    },
    (args) =>
      wrap(async () => {
        const result = await record(args.journey, {mode: args.mode, scale: args.scale});
        const project = await loadProject();
        const content = text(result);
        if (result.data.plates?.plates.length) {
          const dir = path.join(project.root, result.data.dir);
          content.push(image(await contactSheet(result.data.plates.plates.map((p) => ({label: `${p.index}: ${p.beat ?? p.action?.type ?? 'state'}${p.action && 'label' in p.action ? ` → ${p.action.label}` : ''}`, file: path.join(dir, p.file)})))));
        }
        return content;
      }),
  );

  server.registerTool(
    'asset_new',
    {
      description: `Create marketing/gifs/<asset>/ from a template (${TEMPLATES.map((t) => t.id).join(', ')}) and format (16:9, 1:1, 4:5, 9:16, modal-portrait, card, WIDTHxHEIGHT). product-walkthrough needs a recorded journey. Then edit scene.html (data block first) and brief.md.`,
      inputSchema: {asset: z.string(), template: z.enum(TEMPLATES.map((t) => t.id) as [string, ...string[]]).optional(), format: z.string().optional(), journey: z.string().optional(), title: z.string().optional(), media: z.array(z.string()).optional(), force: z.boolean().optional()},
    },
    (args) => wrap(async () => text(await newAsset(args.asset, {...args, template: args.template as never}))),
  );
  server.registerTool('media_add', {description: 'Copy repo images/logos/videos into <asset>/media/ so scene.html can reference them as media/<file>.', inputSchema: {asset: z.string(), files: z.array(z.string())}}, (args) =>
    wrap(async () => text(await addMedia(args.asset, args.files))),
  );
  server.registerTool(
    'scene_preview',
    {
      description: 'Look at a scene without exporting: seeks the working scene.html (or a version) to each beat, or to the given times in ms, and returns a contact sheet plus any page errors. Use after every scene edit, before render.',
      inputSchema: {asset: z.string(), at: z.array(z.number()).optional(), version: z.string().optional()},
      annotations: {readOnlyHint: true},
    },
    (args) =>
      wrap(async () => {
        const result = await previewScene(args.asset, {at: args.at, version: args.version});
        return [...text(result), image(result.sheet)];
      }),
  );
  server.registerTool(
    'render',
    {
      description: 'Snapshot scene.html as the next version (vN) and export GIF + MP4 + one still per beat, named <asset>-vN-<seconds>s.<ext>. Pass version to re-encode an existing version after pacing changes. Takes a while for long scenes.',
      inputSchema: {asset: z.string(), version: z.string().optional(), formats: z.array(z.enum(['gif', 'mp4'])).optional(), fps: z.number().int().optional(), scale: z.number().optional()},
    },
    (args) =>
      wrap(async () => {
        const result = await renderAsset(args.asset, args);
        const project = await loadProject();
        const content = text(result);
        if (result.data.stills.length) content.push(image(await contactSheet(result.data.stills.map((s) => ({label: path.basename(s), file: path.join(project.root, s)})))));
        return content;
      }),
  );
  server.registerTool(
    'studio_start',
    {description: 'Start the review studio in the background and return its URL. Tell the user to open it, pick the version, click on the frame to pin notes (images can be pasted), then say "apply notes from vN".', inputSchema: {port: z.number().int().optional()}},
    (args) => wrap(async () => text(await ensureStudioRunning(undefined, {port: args.port}))),
  );
  server.registerTool(
    'notes',
    {
      description: 'Review notes left in the studio, as markdown with time, position and attachment paths. For "apply notes from vN" pass version: "vN". Open attachments (images) to see what the user meant.',
      inputSchema: {asset: z.string(), version: z.string().optional(), open: z.boolean().optional()},
      annotations: {readOnlyHint: true},
    },
    (args) => wrap(async () => text(await notesFor(args.asset, args), {data: false})),
  );
  server.registerTool('note_done', {description: 'Mark a note done (or reopen it).', inputSchema: {asset: z.string(), id: z.string(), done: z.boolean().optional()}}, (args) =>
    wrap(async () => text(await resolveNote(args.asset, args.id, args.done ?? true))),
  );
  server.registerTool(
    'pacing',
    {description: 'Get or set per-section speed multipliers (section ids come from scene sections). Render with version to apply without changing the scene.', inputSchema: {asset: z.string(), speeds: z.record(z.string(), z.number()).optional()}},
    (args) => wrap(async () => text(await setPacing(args.asset, args.speeds))),
  );
  server.registerTool('promote', {description: 'Ship a version: copy GIF, MP4 and stills to <asset>/final/ and archive older versions. Only after the user approves.', inputSchema: {asset: z.string(), version: z.string()}}, (args) =>
    wrap(async () => text(await promote(args.asset, args.version))),
  );

  const shutdown = async () => {
    await session?.close();
  };
  process.once('exit', () => void shutdown());
  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
