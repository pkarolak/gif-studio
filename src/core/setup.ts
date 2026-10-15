import {existsSync} from 'node:fs';
import {appendFile, copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {appStatus} from './app.js';
import {assetSummary, listAssetNames, TEMPLATES} from './assets.js';
import {FORMAT_PRESETS} from '../shared/contract.js';
import {loadJourneys} from './journeys.js';
import {outcome, type Outcome} from './outcome.js';
import {CONFIG_FILE, loadProject, packageRoot, readJson, relative, STATE_DIR, writeJson} from './project.js';
import type {Inventory} from './scan.js';

export type AgentTarget = 'cursor' | 'claude' | 'agents';

const MCP_ENTRY = {command: 'npx', args: ['-y', 'gif-studio', 'mcp']};

async function mergeMcpConfig(file: string): Promise<boolean> {
  const config = await readJson<{mcpServers?: Record<string, unknown>}>(file, {});
  config.mcpServers ??= {};
  if (config.mcpServers['gif-studio']) return false;
  config.mcpServers['gif-studio'] = MCP_ENTRY;
  await writeJson(file, config);
  return true;
}

export async function installSkill(targets: AgentTarget[] = ['cursor', 'claude']): Promise<Outcome<string[]>> {
  const project = await loadProject();
  const source = path.join(packageRoot(), 'skill', 'SKILL.md');
  const written: string[] = [];
  for (const target of targets) {
    const dir = target === 'cursor' ? '.cursor/skills/gif-studio' : target === 'claude' ? '.claude/skills/gif-studio' : '.agents/skills/gif-studio';
    const file = path.join(project.root, dir, 'SKILL.md');
    await mkdir(path.dirname(file), {recursive: true});
    await copyFile(source, file);
    written.push(relative(project, file));
  }
  return outcome(written, `Installed the gif-studio skill: ${written.join(', ')}`);
}

export async function registerMcp(targets: AgentTarget[] = ['cursor', 'claude']): Promise<Outcome<string[]>> {
  const project = await loadProject();
  const changed: string[] = [];
  for (const target of targets) {
    const file = target === 'cursor' ? path.join(project.root, '.cursor', 'mcp.json') : target === 'claude' ? path.join(project.root, '.mcp.json') : null;
    if (file && (await mergeMcpConfig(file))) changed.push(relative(project, file));
  }
  return outcome(changed, changed.length ? `Registered the gif-studio MCP server in ${changed.join(', ')}. Restart or reload the agent to pick it up.` : 'MCP server already registered.');
}

export interface InitOptions {
  assetsDir?: string;
  skill?: boolean;
  mcp?: boolean;
  targets?: AgentTarget[];
}

export async function init(options: InitOptions = {}): Promise<Outcome<{created: string[]; skill: string[]; mcp: string[]}>> {
  const root = path.resolve(process.env.GIF_STUDIO_ROOT ?? process.cwd());
  const created: string[] = [];
  const configPath = path.join(root, CONFIG_FILE);
  if (!existsSync(configPath)) {
    await writeJson(configPath, {
      assetsDir: options.assetsDir ?? 'marketing/gifs',
      viewport: {width: 1440, height: 900},
      mask: [],
      render: {fps: 30, scale: 2, gifFps: 20, gifScale: 1, formats: ['gif', 'mp4']},
    });
    created.push(CONFIG_FILE);
  }
  process.env.GIF_STUDIO_ROOT = root;
  const project = await loadProject(root);
  await mkdir(project.assetsDir, {recursive: true});
  await mkdir(project.stateDir, {recursive: true});
  created.push(relative(project, project.assetsDir), STATE_DIR);

  const gitignore = path.join(root, '.gitignore');
  const existing = existsSync(gitignore) ? await readFile(gitignore, 'utf8') : '';
  const ignoreLines = [`${STATE_DIR}/`].filter((line) => !existing.split(/\r?\n/).includes(line));
  if (ignoreLines.length) {
    await appendFile(gitignore, `${existing && !existing.endsWith('\n') ? '\n' : ''}# gif-studio local state (auth sessions, explore cache, temp frames)\n${ignoreLines.join('\n')}\n`);
    created.push('.gitignore entry');
  }
  const assetsReadme = path.join(project.assetsDir, 'README.md');
  if (!existsSync(assetsReadme)) {
    await writeFile(assetsReadme, `# Marketing GIFs\n\nMade with [gif-studio](https://github.com/pkarolak/gif-studio). Run \`npx gif-studio guide\` for the workflow.\n\nEach folder is one asset: \`scene.html\` (animation source), \`brief.md\` (copy = script), \`notes.json\` (review notes), \`versions/\` (every render), \`final/\` (shipped GIF + MP4 + stills).\n`);
  }

  const targets = options.targets ?? ['cursor', 'claude'];
  const skill = options.skill === false ? [] : (await installSkill(targets)).data;
  const mcp = options.mcp === false ? [] : (await registerMcp(targets)).data;

  return outcome(
    {created, skill, mcp},
    [
      `Initialized gif-studio in ${root}`,
      created.length ? `Created: ${created.join(', ')}` : null,
      skill.length ? `Skill: ${skill.join(', ')}` : null,
      mcp.length ? `MCP: ${mcp.join(', ')} (reload the agent to load the tools)` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    ['gif-studio guide', 'gif-studio scan'],
  );
}

export async function status(): Promise<Outcome<Record<string, unknown>>> {
  const project = await loadProject();
  const inventory = await readJson<Inventory | null>(path.join(project.stateDir, 'inventory.json'), null);
  const sitemap = await readJson<{pages: unknown[]; suggestedJourneys: Array<{id: string}>} | null>(path.join(project.stateDir, 'explore', 'sitemap.json'), null);
  const journeys = await loadJourneys(project).catch(() => []);
  const assets = await Promise.all((await listAssetNames(project)).map((name) => assetSummary(project, name)));
  const app = (await appStatus()).data;

  const next: string[] = [];
  if (!project.hasConfig) next.push('gif-studio init');
  if (!inventory) next.push('gif-studio scan');
  else if (inventory.kind === 'app' && !app?.reachable) next.push('gif-studio app start');
  else if (inventory.kind === 'app' && !sitemap) next.push('gif-studio explore');
  if (sitemap && !journeys.length) next.push('Propose journeys from .gif-studio/explore/sitemap.json, then gif-studio journeys save');
  for (const journey of journeys) {
    if (!existsSync(path.join(project.assetsDir, 'captures', journey.id, 'plates.json'))) next.push(`gif-studio record ${journey.id}`);
  }
  for (const asset of assets) {
    if (!asset.latest) next.push(`gif-studio render ${asset.asset}`);
    else if (asset.openNotes) next.push(`gif-studio notes ${asset.asset} --open  # ${asset.openNotes} open note(s)`);
  }

  const data = {
    root: project.root,
    initialized: project.hasConfig,
    inventory: inventory ? {kind: inventory.kind, name: inventory.name, framework: inventory.app?.framework ?? null, scannedAt: inventory.scannedAt} : null,
    app,
    explored: sitemap ? {pages: sitemap.pages.length, suggested: sitemap.suggestedJourneys.map((j) => j.id)} : null,
    journeys: journeys.map((j) => ({id: j.id, title: j.title, recorded: existsSync(path.join(project.assetsDir, 'captures', j.id, 'plates.json'))})),
    assets,
  };
  const summary = [
    `Project: ${project.root}${project.hasConfig ? '' : ' (not initialized)'}`,
    `Inventory: ${data.inventory ? `${data.inventory.kind}${data.inventory.name ? ` — ${data.inventory.name}` : ''}` : 'not scanned'}`,
    `App: ${app ? `${app.url} (${app.reachable ? 'up' : 'down'})` : 'not running'}`,
    `Explored: ${data.explored ? `${data.explored.pages} pages` : 'no'}`,
    `Journeys: ${data.journeys.map((j) => `${j.id}${j.recorded ? ' ✓' : ''}`).join(', ') || 'none'}`,
    `Assets: ${assets.map((a) => `${a.asset} ${a.latest ?? '(no renders)'}${a.openNotes ? ` [${a.openNotes} open notes]` : ''}${a.final ? ' [final]' : ''}`).join(', ') || 'none'}`,
  ].join('\n');
  return outcome(data, summary, next);
}

export async function guide(): Promise<Outcome<{markdown: string}>> {
  const markdown = await readFile(path.join(packageRoot(), 'AGENTS.md'), 'utf8');
  return outcome({markdown}, markdown, ['gif-studio status']);
}

export function templatesInfo(): Outcome<{templates: typeof TEMPLATES; formats: typeof FORMAT_PRESETS}> {
  return outcome(
    {templates: TEMPLATES, formats: FORMAT_PRESETS},
    [
      'Templates:',
      ...TEMPLATES.map((t) => `  ${t.id} (needs ${t.needs}): ${t.description}`),
      'Formats:',
      ...FORMAT_PRESETS.map((f) => `  ${f.id} ${f.width}x${f.height}: ${f.description}`),
      '  or any WIDTHxHEIGHT',
    ].join('\n'),
  );
}
