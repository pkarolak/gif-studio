import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Command, Option} from 'commander';
import {appStatus, startApp, stopApp} from '../core/app.js';
import {addMedia, newAsset, notesFor, promote, resolveNote, setPacing, TEMPLATES, type TemplateId} from '../core/assets.js';
import {authLogin} from '../core/auth.js';
import {browse, type BrowseAction} from '../core/browse.js';
import type {Target} from '../core/browser.js';
import {explore} from '../core/explore.js';
import {listJourneys, saveJourneys} from '../core/journeys.js';
import {StudioError, type Outcome} from '../core/outcome.js';
import {loadProject, packageRoot, readJson} from '../core/project.js';
import {record, type RecordMode} from '../core/record.js';
import {renderAsset, type RenderFormat} from '../core/render.js';
import {scan} from '../core/scan.js';
import {previewScene} from '../core/preview.js';
import {guide, init, installSkill, registerMcp, status, templatesInfo, type AgentTarget} from '../core/setup.js';

const program = new Command();
const pkg = JSON.parse(await readFile(path.join(packageRoot(), 'package.json'), 'utf8')) as {version: string};

program
  .name('gif-studio')
  .description('AI-first studio: turn any repo, app or folder into GIF and MP4 marketing assets.\nAgents: start with `gif-studio guide`, then `gif-studio status --json`.')
  .version(pkg.version, '-v, --cli-version')
  .enablePositionalOptions()
  .option('--json', 'print a machine-readable {ok, data, summary, next} envelope')
  .showHelpAfterError();

function wantsJson(): boolean {
  return Boolean(program.opts().json) || process.argv.includes('--json');
}

function print<T>(result: Outcome<T>): void {
  if (wantsJson()) {
    process.stdout.write(`${JSON.stringify({ok: true, data: result.data, summary: result.summary, next: result.next}, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.summary}\n`);
  if (result.next.length) process.stdout.write(`\nNext:\n${result.next.map((n) => `  - ${n}`).join('\n')}\n`);
}

function fail(error: unknown): never {
  const err = error as Error & {hint?: string};
  if (wantsJson()) {
    process.stdout.write(`${JSON.stringify({ok: false, error: err.message, hint: err.hint ?? null}, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${err.message}\n${err.hint ? `Hint: ${err.hint}\n` : ''}`);
    if (!(err instanceof StudioError) && process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}

function action<A extends unknown[]>(fn: (...args: A) => Promise<Outcome<unknown>> | Outcome<unknown>) {
  return async (...args: A) => {
    try {
      print(await fn(...args));
    } catch (error) {
      fail(error);
    }
  };
}

function parseTarget(value: string): Target {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Target;
  const role = /^role=(\w+)(?::(.+))?$/.exec(trimmed);
  if (role) return {role: role[1]!, ...(role[2] ? {name: role[2]} : {})};
  const label = /^label=(.+)$/.exec(trimmed);
  if (label) return {label: label[1]!};
  return trimmed;
}

const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);
const int = (value: string) => Number.parseInt(value, 10);
const num = (value: string) => Number.parseFloat(value);

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, {stdio: 'ignore', detached: true}).on('error', () => undefined).unref();
}

program
  .command('init')
  .description('set up gif-studio in this repo: config, marketing/gifs/, skill for Cursor + Claude Code, MCP registration')
  .option('--assets-dir <dir>', 'where assets live', 'marketing/gifs')
  .option('--no-skill', 'do not install the agent skill')
  .option('--no-mcp', 'do not register the MCP server')
  .option('--target <targets>', 'agents to set up: cursor,claude,agents', list)
  .action(action((opts: {assetsDir: string; skill: boolean; mcp: boolean; target?: AgentTarget[]}) => init({assetsDir: opts.assetsDir, skill: opts.skill, mcp: opts.mcp, targets: opts.target})));

program.command('guide').description('print the agent playbook (read this first)').action(action(() => guide()));
program.command('status').description('where the project is: inventory, app, journeys, assets, versions, open notes, and what to do next').action(action(() => status()));
program.command('templates').description('list scene templates and format presets').action(action(() => templatesInfo()));
program.command('scan [path]').description('inventory a location: kind, framework, dev command, routes, brand, media, pitch, seed accounts').action(action((target?: string) => scan(target)));

const app = program.command('app').description('run the app under test');
app
  .command('start')
  .description('detect and start the dev server (or reuse a running one), wait until reachable')
  .option('--command <cmd>', 'override the dev command')
  .option('--url <url>', 'use an already running or deployed app')
  .option('--cwd <dir>', 'app directory inside the repo')
  .option('--static', 'serve the folder as a static site')
  .option('--timeout <seconds>', 'wait time', int)
  .action(action((opts: {command?: string; url?: string; cwd?: string; static?: boolean; timeout?: number}) => startApp({...opts, timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined})));
app.command('stop').description('stop the app started by gif-studio').action(action(() => stopApp()));
app.command('status').description('is the app reachable').action(action(() => appStatus()));

program
  .command('auth')
  .description('authentication for apps behind a login')
  .command('login [url]')
  .description('open a visible browser, let the user log in once, save the session for later runs')
  .option('--name <name>', 'session name', 'default')
  .action(action((url: string | undefined, opts: {name: string}) => authLogin({url, name: opts.name})));

const browseCmd = program.command('browse').description('drive a browser against the app; every command saves a screenshot (CLI reopens the last URL each call)');
const runBrowse = (request: BrowseAction) => browse(request);
browseCmd.command('open <url>').description('open a path (/pricing) or full URL').action(action((url: string) => runBrowse({action: 'open', url})));
browseCmd.command('click <target>').description('click: text, CSS selector, role=button:Name, label=Email, or JSON target').action(action((target: string) => runBrowse({action: 'click', target: parseTarget(target)})));
browseCmd
  .command('type <target> <text>')
  .option('--submit', 'press Enter after typing')
  .action(action((target: string, text: string, opts: {submit?: boolean}) => runBrowse({action: 'type', target: parseTarget(target), text, submit: opts.submit})));
browseCmd.command('press <key>').action(action((key: string) => runBrowse({action: 'press', key})));
browseCmd.command('hover <target>').action(action((target: string) => runBrowse({action: 'hover', target: parseTarget(target)})));
browseCmd
  .command('scroll')
  .option('--to <target>', 'scroll an element into view')
  .option('--y <pixels>', 'scroll by pixels', int)
  .action(action((opts: {to?: string; y?: number}) => runBrowse({action: 'scroll', to: opts.to ? parseTarget(opts.to) : undefined, y: opts.y})));
browseCmd
  .command('screenshot [url]')
  .option('--full', 'full page')
  .action(action((url: string | undefined, opts: {full?: boolean}) => runBrowse({action: 'screenshot', url, fullPage: opts.full})));
browseCmd.command('snapshot [url]').description('compact page model: headings, interactive elements with boxes, aria tree').action(action((url?: string) => runBrowse({action: 'snapshot', url})));
browseCmd.command('links [url]').action(action((url?: string) => runBrowse({action: 'links', url})));

program
  .command('explore [start]')
  .description('crawl the running app: screenshot + summary per page, sitemap, suggested journeys')
  .option('--max-pages <n>', 'page budget', int, 20)
  .option('--max-depth <n>', 'link depth', int, 2)
  .action(action((start: string | undefined, opts: {maxPages: number; maxDepth: number}) => explore({start, maxPages: opts.maxPages, maxDepth: opts.maxDepth})));

const journeys = program.command('journeys').description('core user journeys to record (marketing/gifs/journeys.json)');
journeys.command('list').action(action(() => listJourneys()));
journeys
  .command('save <file>')
  .description('save journeys from a JSON file ("-" for stdin): {journeys:[…]}, an array, or one journey')
  .option('--replace', 'replace all journeys instead of merging by id')
  .action(
    action(async (file: string, opts: {replace?: boolean}) => {
      const raw = file === '-' ? await readStdin() : await readFile(path.resolve(file), 'utf8');
      return saveJourneys(JSON.parse(raw), {replace: opts.replace});
    }),
  );
journeys.command('suggest').description('print journeys suggested by the last explore').action(
  action(async () => {
    const project = await loadProject();
    const sitemap = await readJson<{suggestedJourneys: unknown[]} | null>(path.join(project.stateDir, 'explore', 'sitemap.json'), null);
    if (!sitemap) throw new StudioError('No sitemap yet.', 'gif-studio explore');
    return {data: sitemap.suggestedJourneys, summary: JSON.stringify({journeys: sitemap.suggestedJourneys}, null, 2), next: ['Edit the steps and save the approved ones: gif-studio journeys save <file.json>']};
  }),
);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

program
  .command('record <journey>')
  .description('replay a journey: plates (hi-res screenshots + element boxes) and/or footage (screen recording)')
  .addOption(new Option('--mode <mode>', 'what to capture').choices(['plates', 'footage', 'both']).default('plates'))
  .option('--scale <n>', 'device scale factor for plates', num)
  .option('--fps <n>', 'footage frame rate', int)
  .action(action((journey: string, opts: {mode: RecordMode; scale?: number; fps?: number}) => record(journey, opts)));

program
  .command('new <asset>')
  .description('create an asset folder from a template: scene.html, brief.md, notes.json, pacing.json, media/')
  .addOption(new Option('--template <id>', 'scene template').choices(TEMPLATES.map((t) => t.id)))
  .option('--format <format>', '16:9, 1:1, 4:5, 9:16, modal-portrait, card, or WIDTHxHEIGHT', '16:9')
  .option('--journey <id>', 'recorded journey to animate')
  .option('--title <title>', 'headline')
  .option('--media <files>', 'comma-separated images to copy into media/', list)
  .option('--force', 'overwrite scene.html')
  .action(action((asset: string, opts: {template?: TemplateId; format: string; journey?: string; title?: string; media?: string[]; force?: boolean}) => newAsset(asset, opts)));

program
  .command('media')
  .description('manage asset media')
  .command('add <asset> <files...>')
  .description('copy images, logos or videos into <asset>/media/')
  .action(action((asset: string, files: string[]) => addMedia(asset, files)));

program
  .command('render <asset>')
  .description('snapshot scene.html as the next version and export GIF + MP4 + stills (or re-encode --version vN)')
  .option('--version <vN>', 're-render an existing version (e.g. after pacing changes)')
  .option('--format <formats>', 'gif,mp4', list)
  .option('--fps <n>', 'capture frame rate', int)
  .option('--scale <n>', 'device scale factor', num)
  .option('--gif-fps <n>', 'GIF frame rate', int)
  .option('--gif-scale <n>', 'GIF size relative to the scene', num)
  .option('--workers <n>', 'parallel browser pages', int)
  .option('--no-stills', 'skip beat stills')
  .action(
    action((asset: string, opts: {version?: string; format?: RenderFormat[]; fps?: number; scale?: number; gifFps?: number; gifScale?: number; workers?: number; stills: boolean}) => {
      const tty = process.stderr.isTTY && !wantsJson();
      return renderAsset(asset, {
        ...opts,
        formats: opts.format,
        onProgress: (p) => {
          if (tty) process.stderr.write(`\r${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`.padEnd(40));
          if (tty && p.phase === 'done') process.stderr.write('\r'.padEnd(41) + '\r');
        },
      });
    }),
  );

program
  .command('preview <asset>')
  .description('look at a scene without exporting: frames at every beat (or --at times in ms) + a contact sheet')
  .option('--at <times>', 'comma-separated times in ms', (v) => list(v).map(Number))
  .option('--version <vN>', 'preview a frozen version instead of the working scene.html')
  .action(
    action(async (asset: string, opts: {at?: number[]; version?: string}) => {
      const result = await previewScene(asset, opts);
      const project = await loadProject();
      const sheet = path.join(project.stateDir, 'preview', asset, 'sheet.jpg');
      await writeFile(sheet, result.sheet);
      return {...result, summary: `${result.summary}\nContact sheet: ${path.relative(project.root, sheet)}`};
    }),
  );

program
  .command('notes <asset>')
  .description('review notes as agent-readable markdown; "apply notes from vN" = --version vN')
  .option('--version <vN>', 'notes left on this version')
  .option('--open', 'only notes not done and not covered by a newer version')
  .option('--done <id>', 'mark a note done')
  .option('--reopen <id>', 'mark a note open again')
  .action(
    action((asset: string, opts: {version?: string; open?: boolean; done?: string; reopen?: string}) => {
      if (opts.done) return resolveNote(asset, opts.done, true);
      if (opts.reopen) return resolveNote(asset, opts.reopen, false);
      return notesFor(asset, {version: opts.version, open: opts.open});
    }),
  );

program
  .command('pacing <asset>')
  .description('show or set section speeds (same as the studio Pacing tab)')
  .option('--set <pairs>', 'section=speed pairs, e.g. step-2=1.5,outro=0.8', list)
  .action(
    action((asset: string, opts: {set?: string[]}) =>
      setPacing(asset, opts.set ? Object.fromEntries(opts.set.map((pair) => pair.split('=')).map(([k, v]) => [k!, Number(v)])) : undefined),
    ),
  );

program
  .command('promote <asset> <version>')
  .description('ship a version: copy GIF + MP4 + stills into final/, archive older versions')
  .action(action((asset: string, version: string) => promote(asset, version)));

program
  .command('studio')
  .description('open the review studio: live preview, scrubbing, pinned notes with images, versions, pacing, export')
  .option('--port <port>', 'port', int)
  .option('--host <host>', 'host', '127.0.0.1')
  .option('--no-open', 'do not open a browser')
  .option('--background', 'start detached and return immediately')
  .action(async (opts: {port?: number; host: string; open: boolean; background?: boolean}) => {
    try {
      if (opts.background) {
        const {ensureStudioRunning} = await import('../server/studio.js');
        const result = await ensureStudioRunning(undefined, {port: opts.port});
        if (opts.open) openUrl(result.data.url);
        return print(result);
      }
      const {startStudioServer} = await import('../server/studio.js');
      const studio = await startStudioServer({port: opts.port, host: opts.host});
      process.stdout.write(`gif-studio studio running at ${studio.url}\n`);
      if (opts.open) openUrl(studio.url);
      const shutdown = async () => {
        await studio.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('mcp')
  .description('run the local MCP server over stdio (registered by `gif-studio init`)')
  .action(async () => {
    const {runMcpServer} = await import('../mcp/server.js');
    await runMcpServer();
  });

program
  .command('skill')
  .description('agent skill')
  .command('install')
  .option('--target <targets>', 'cursor,claude,agents', list)
  .option('--mcp', 'also register the MCP server')
  .action(
    action(async (opts: {target?: AgentTarget[]; mcp?: boolean}) => {
      const skill = await installSkill(opts.target);
      if (!opts.mcp) return skill;
      const mcp = await registerMcp(opts.target);
      return {data: [...skill.data, ...mcp.data], summary: `${skill.summary}\n${mcp.summary}`, next: []};
    }),
  );

function addJsonFlag(command: Command): void {
  for (const sub of command.commands) {
    if (!sub.options.some((o) => o.long === '--json')) sub.option('--json', 'machine-readable output');
    addJsonFlag(sub);
  }
}
addJsonFlag(program);

await program.parseAsync(process.argv);
