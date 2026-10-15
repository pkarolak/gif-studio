import type {SceneBeat, SceneSection} from './pacing.js';

export const SCENE_CONTRACT_VERSION = 1;

export interface SceneManifest {
  contract?: number;
  width: number;
  height: number;
  duration: number;
  sections: SceneSection[];
  beats: SceneBeat[];
}

export interface SceneHandle extends SceneManifest {
  seek(t: number): void | Promise<void>;
  ready?: Promise<unknown>;
}

export interface FormatPreset {
  id: string;
  width: number;
  height: number;
  description: string;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  {id: '16:9', width: 960, height: 540, description: 'Landscape: product pages, YouTube, slides (1920x1080 at scale 2)'},
  {id: '1:1', width: 720, height: 720, description: 'Square: social feeds (1440x1440 at scale 2)'},
  {id: '4:5', width: 720, height: 900, description: 'Portrait feed: Instagram, LinkedIn (1440x1800 at scale 2)'},
  {id: '9:16', width: 540, height: 960, description: 'Vertical: stories, reels, shorts (1080x1920 at scale 2)'},
  {id: 'modal-portrait', width: 480, height: 630, description: 'In-product announcement modal'},
  {id: 'card', width: 480, height: 250, description: 'In-product step card'},
];

export function resolveFormat(format: string | undefined): {width: number; height: number; id: string} {
  const value = format ?? '16:9';
  const preset = FORMAT_PRESETS.find((p) => p.id === value);
  if (preset) return preset;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match) return {id: value, width: Number(match[1]), height: Number(match[2])};
  throw new Error(`Unknown format "${value}". Use one of ${FORMAT_PRESETS.map((p) => p.id).join(', ')} or WIDTHxHEIGHT.`);
}
