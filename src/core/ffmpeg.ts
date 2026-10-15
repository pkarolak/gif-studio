import {spawn, spawnSync} from 'node:child_process';
import {accessSync, chmodSync, constants, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {StudioError} from './outcome.js';

let cached: string | null = null;

function works(binary: string): boolean {
  try {
    return spawnSync(binary, ['-hide_banner', '-version'], {stdio: 'ignore'}).status === 0;
  } catch {
    return false;
  }
}

function ensureExecutable(file: string): void {
  try {
    accessSync(file, constants.X_OK);
  } catch {
    try {
      chmodSync(file, 0o755);
    } catch {
      // read-only install; resolution falls through to the error below
    }
  }
}

export function resolveFfmpeg(): string {
  if (cached) return cached;
  const candidates: string[] = [];
  if (process.env.GIF_STUDIO_FFMPEG) candidates.push(process.env.GIF_STUDIO_FFMPEG);
  candidates.push('ffmpeg');
  try {
    const require = createRequire(import.meta.url);
    const bundled = require('@ffmpeg-installer/ffmpeg') as {path: string};
    if (existsSync(bundled.path)) {
      ensureExecutable(bundled.path);
      candidates.push(bundled.path);
    }
  } catch {
    // optional platform binary missing
  }
  for (const candidate of candidates) {
    if (works(candidate)) {
      cached = candidate;
      return candidate;
    }
  }
  throw new StudioError('ffmpeg not found.', 'Install ffmpeg (brew install ffmpeg / apt install ffmpeg) or set GIF_STUDIO_FFMPEG to its path.');
}

export function hasBinary(name: string): boolean {
  return works(name) || spawnSync(name, ['--version'], {stdio: 'ignore'}).status === 0;
}

export function run(binary: string, args: string[], options: {cwd?: string} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new StudioError(`${binary} exited with ${code}:\n${output.slice(-3000)}`));
    });
  });
}

export function ffmpeg(args: string[]): Promise<string> {
  return run(resolveFfmpeg(), ['-hide_banner', '-y', ...args]);
}

export async function probe(file: string): Promise<{durationMs: number; frames: number; width: number; height: number}> {
  const output = await run(resolveFfmpeg(), ['-hide_banner', '-i', file, '-f', 'null', '-']).catch((e: Error) => e.message);
  const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(output);
  const frameMatches = [...output.matchAll(/frame=\s*(\d+)/g)];
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(output);
  return {
    durationMs: duration ? (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000 : 0,
    frames: frameMatches.length ? Number(frameMatches[frameMatches.length - 1]![1]) : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  };
}
