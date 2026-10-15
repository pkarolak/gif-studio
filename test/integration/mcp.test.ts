import {cpSync} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {tempDir} from '../helpers.js';

const repo = path.resolve(import.meta.dirname, '..', '..');
let client: Client;
let cleanup = () => {};

type ToolResult = {isError?: boolean; content: Array<{type: string; text?: string; mimeType?: string}>};
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({name, arguments: args}) as Promise<ToolResult>;

beforeAll(async () => {
  const temp = tempDir('gif-studio-mcp-');
  cleanup = temp.cleanup;
  cpSync(path.join(repo, 'examples', 'demo-app'), temp.dir, {recursive: true});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'dist', 'cli', 'index.js'), 'mcp'],
    cwd: temp.dir,
    env: {...(process.env as Record<string, string>), GIF_STUDIO_ROOT: temp.dir},
    stderr: 'ignore',
  });
  client = new Client({name: 'gif-studio-test', version: '0.0.0'});
  await client.connect(transport);
  await call('init', {});
});

afterAll(async () => {
  await call('app_stop').catch(() => undefined);
  await client?.close();
  cleanup();
});

describe('mcp server', () => {
  it('lists the tools and the guide resource', async () => {
    const {tools} = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['guide', 'status', 'scan', 'app_start', 'browser_screenshot', 'explore', 'record', 'asset_new', 'render', 'notes', 'promote']) {
      expect(names).toContain(name);
    }
    expect(client.getInstructions()).toContain('guide');
    const {resources} = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('gif-studio://guide');
  });

  it('scans and returns screenshots inline', async () => {
    const scan = await call('scan');
    expect(scan.isError).toBeFalsy();
    expect(scan.content[0]!.text).toContain('app');
    await call('app_start');
    const shot = await call('browser_screenshot', {url: '/'});
    expect(shot.content.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg')).toBe(true);
  });

  it('returns errors with hints', async () => {
    const result = await call('render', {asset: 'missing'});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Hint');
  });
});
