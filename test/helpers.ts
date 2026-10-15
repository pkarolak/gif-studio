import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'gif-studio-'): {dir: string; cleanup(): void} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {dir, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, contents);
  }
}

export function tempProject(config: Record<string, unknown> = {}): {dir: string; cleanup(): void} {
  const temp = tempDir();
  writeFiles(temp.dir, {'gif-studio.config.json': JSON.stringify(config)});
  const previous = process.env.GIF_STUDIO_ROOT;
  process.env.GIF_STUDIO_ROOT = temp.dir;
  return {
    dir: temp.dir,
    cleanup: () => {
      if (previous === undefined) delete process.env.GIF_STUDIO_ROOT;
      else process.env.GIF_STUDIO_ROOT = previous;
      temp.cleanup();
    },
  };
}

export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
