import {afterEach, describe, expect, it} from 'vitest';
import {resolveFormat} from '../src/shared/contract.js';
import {configSchema, loadProject, slugify} from '../src/core/project.js';
import {tempProject} from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('config', () => {
  it('fills defaults', () => {
    const config = configSchema.parse({});
    expect(config.assetsDir).toBe('marketing/gifs');
    expect(config.render).toMatchObject({fps: 30, scale: 2, gifFps: 20, gifScale: 1, formats: ['gif', 'mp4']});
    expect(config.viewport).toEqual({width: 1440, height: 900});
  });

  it('rejects invalid values', () => {
    expect(configSchema.safeParse({render: {formats: ['avi']}}).success).toBe(false);
  });

  it('loads the project from GIF_STUDIO_ROOT', async () => {
    const project = tempProject({assetsDir: 'assets/gifs'});
    cleanup = project.cleanup;
    const loaded = await loadProject();
    expect(loaded.root).toBe(project.dir);
    expect(loaded.assetsDir.endsWith('assets/gifs')).toBe(true);
  });
});

describe('formats', () => {
  it('resolves presets and custom sizes', () => {
    expect(resolveFormat(undefined)).toMatchObject({width: 960, height: 540});
    expect(resolveFormat('9:16')).toMatchObject({width: 540, height: 960});
    expect(resolveFormat('800x600')).toEqual({id: '800x600', width: 800, height: 600});
    expect(() => resolveFormat('huge')).toThrow();
  });

  it('slugifies names', () => {
    expect(slugify('Create a Project!')).toBe('create-a-project');
  });
});
