export interface SceneSection {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface SceneBeat {
  t: number;
  label: string;
}

export type PacingSpeeds = Record<string, number>;

export interface PacedSegment {
  id: string | null;
  label: string;
  sceneStart: number;
  sceneEnd: number;
  speed: number;
  studioStart: number;
  studioEnd: number;
}

const MIN_SPEED = 0.1;

export function buildPacing(duration: number, sections: SceneSection[], speeds: PacingSpeeds = {}): PacedSegment[] {
  const sorted = [...sections]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({...s, start: Math.max(0, s.start), end: Math.min(duration, s.end)}));

  const raw: Array<Omit<PacedSegment, 'studioStart' | 'studioEnd'>> = [];
  let cursor = 0;
  for (const section of sorted) {
    const start = Math.max(section.start, cursor);
    if (start >= section.end) continue;
    if (start > cursor) raw.push({id: null, label: 'Gap', sceneStart: cursor, sceneEnd: start, speed: 1});
    const speed = Math.max(MIN_SPEED, speeds[section.id] ?? 1);
    raw.push({id: section.id, label: section.label, sceneStart: start, sceneEnd: section.end, speed});
    cursor = section.end;
  }
  if (cursor < duration) raw.push({id: null, label: 'Gap', sceneStart: cursor, sceneEnd: duration, speed: 1});

  let studio = 0;
  return raw.map((segment) => {
    const length = (segment.sceneEnd - segment.sceneStart) / segment.speed;
    const paced = {...segment, studioStart: studio, studioEnd: studio + length};
    studio += length;
    return paced;
  });
}

export function pacedDuration(segments: PacedSegment[]): number {
  return segments.length ? segments[segments.length - 1]!.studioEnd : 0;
}

export function studioToScene(segments: PacedSegment[], studioTime: number): number {
  if (!segments.length) return studioTime;
  const segment =
    segments.find((s) => studioTime >= s.studioStart && studioTime < s.studioEnd) ?? segments[segments.length - 1]!;
  const offset = Math.min(Math.max(studioTime - segment.studioStart, 0), segment.studioEnd - segment.studioStart);
  return segment.sceneStart + offset * segment.speed;
}

export function sceneToStudio(segments: PacedSegment[], sceneTime: number): number {
  if (!segments.length) return sceneTime;
  const segment =
    segments.find((s) => sceneTime >= s.sceneStart && sceneTime < s.sceneEnd) ?? segments[segments.length - 1]!;
  const offset = Math.min(Math.max(sceneTime - segment.sceneStart, 0), segment.sceneEnd - segment.sceneStart);
  return segment.studioStart + offset / segment.speed;
}
