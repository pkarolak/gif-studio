import {describe, expect, it} from 'vitest';
import {buildPacing, pacedDuration, sceneToStudio, studioToScene} from '../src/shared/pacing.js';

const sections = [
  {id: 'intro', label: 'Intro', start: 0, end: 1000},
  {id: 'main', label: 'Main', start: 1000, end: 3000},
];

describe('pacing', () => {
  it('is the identity at 1x', () => {
    const segments = buildPacing(4000, sections);
    expect(pacedDuration(segments)).toBe(4000);
    expect(studioToScene(segments, 2500)).toBe(2500);
    expect(sceneToStudio(segments, 2500)).toBe(2500);
  });

  it('fills the tail after the last section with a 1x gap', () => {
    const segments = buildPacing(4000, sections);
    expect(segments.at(-1)).toMatchObject({id: null, sceneStart: 3000, sceneEnd: 4000, speed: 1});
  });

  it('shortens sped-up sections and maps time through them', () => {
    const segments = buildPacing(4000, sections, {main: 2});
    expect(pacedDuration(segments)).toBe(3000);
    expect(studioToScene(segments, 1500)).toBe(2000);
    expect(sceneToStudio(segments, 2000)).toBe(1500);
    expect(studioToScene(segments, 2500)).toBe(3500);
  });

  it('lengthens slowed sections', () => {
    const segments = buildPacing(4000, sections, {intro: 0.5});
    expect(pacedDuration(segments)).toBe(5000);
    expect(studioToScene(segments, 1000)).toBe(500);
  });

  it('round-trips arbitrary times', () => {
    const segments = buildPacing(4000, sections, {intro: 0.75, main: 1.6});
    for (const t of [0, 333, 999, 1000, 1777, 2999, 3500]) {
      expect(studioToScene(segments, sceneToStudio(segments, t))).toBeCloseTo(t, 6);
    }
  });

  it('clamps tiny speeds and ignores overlapping or empty sections', () => {
    const segments = buildPacing(3000, [...sections, {id: 'overlap', label: 'Overlap', start: 500, end: 900}, {id: 'empty', label: 'Empty', start: 10, end: 10}], {intro: 0});
    expect(segments.find((s) => s.id === 'intro')!.speed).toBe(0.1);
    expect(segments.some((s) => s.id === 'overlap' || s.id === 'empty')).toBe(false);
  });

  it('handles scenes without sections', () => {
    const segments = buildPacing(2000, []);
    expect(segments).toHaveLength(1);
    expect(pacedDuration(segments)).toBe(2000);
  });
});
