import {useRef, type PointerEvent as ReactPointerEvent} from 'react';
import {sceneToStudio, type PacedSegment} from '../../src/shared/pacing';
import {formatTime, type Manifest, type Note} from './api';

interface ScrubberProps {
  manifest: Manifest;
  segments: PacedSegment[];
  total: number;
  time: number;
  notes: Array<Note & {number: number}>;
  selectedNote: string | null;
  onScrub(time: number): void;
  onScrubStart(): void;
  onSelectNote(note: Note): void;
}

export function Scrubber({manifest, segments, total, time, notes, selectedNote, onScrub, onScrubStart, onSelectNote}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (studio: number) => `${total ? (studio / total) * 100 : 0}%`;

  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * total;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.note-marker')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onScrubStart();
    onScrub(timeAt(event.clientX));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) onScrub(timeAt(event.clientX));
  };

  return (
    <div className="scrubber">
      <div
        className="track"
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatTime(time)}
        tabIndex={-1}
      >
        <div className="sections">
          {segments.map((segment, i) => (
            <div
              key={`${segment.id ?? 'gap'}-${i}`}
              className={`section-band${segment.id ? '' : ' gap'}${segment.speed !== 1 ? ' paced' : ''}`}
              style={{left: pct(segment.studioStart), width: pct(segment.studioEnd - segment.studioStart)}}
              title={`${segment.label} · ${formatTime(segment.studioEnd - segment.studioStart)}${segment.speed !== 1 ? ` · ${segment.speed}x` : ''}`}
            >
              {segment.id && <span>{segment.label}</span>}
            </div>
          ))}
        </div>
        <div className="progress" style={{width: pct(time)}} />
        {manifest.beats.map((beat, i) => (
          <div key={i} className="beat-marker" style={{left: pct(sceneToStudio(segments, beat.t))}} title={`${beat.label} · ${formatTime(beat.t)}`} />
        ))}
        {notes.map((note) => (
          <button
            key={note.id}
            type="button"
            className={`note-marker${note.open ? '' : ' resolved'}${selectedNote === note.id ? ' selected' : ''}`}
            style={{left: pct(sceneToStudio(segments, note.t))}}
            title={note.text}
            onClick={() => onSelectNote(note)}
          >
            {note.number}
          </button>
        ))}
        <div className="playhead" style={{left: pct(time)}} />
      </div>
    </div>
  );
}
