import {buildPacing, pacedDuration} from '../../src/shared/pacing';
import type {CSSProperties} from 'react';
import {formatTime, type Manifest} from './api';

const MIN_SPEED = 0.25;
const MAX_SPEED = 3;
const ONE_X = ((1 - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;

interface PacingPanelProps {
  manifest: Manifest;
  speeds: Record<string, number>;
  onChange(speeds: Record<string, number>): void;
}

export function PacingPanel({manifest, speeds, onChange}: PacingPanelProps) {
  const segments = buildPacing(manifest.duration, manifest.sections, speeds);
  const total = pacedDuration(segments);
  const changed = Object.values(speeds).some((v) => v !== 1);

  if (!manifest.sections.length) {
    return (
      <div className="panel empty">
        <p>This scene has no sections.</p>
        <p className="muted">Sections come from scene.section(id, start, end) in the scene. Ask your agent to add them to tune pacing per part.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <span className="pacing-total">
          Total <strong>{formatTime(total)}</strong>
          {changed && <span className="muted"> (was {formatTime(manifest.duration)})</span>}
        </span>
        <button type="button" className="ghost small" disabled={!changed} onClick={() => onChange({})}>
          Reset
        </button>
      </div>
      <ul className="pacing-list">
        {manifest.sections.map((section) => {
          const speed = speeds[section.id] ?? 1;
          const length = section.end - section.start;
          const fill = ((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100;
          return (
            <li key={section.id} className={speed !== 1 ? 'paced' : undefined}>
              <div className="pacing-head">
                <span>{section.label}</span>
                <span className="pacing-value">
                  <span className="muted">{formatTime(length / speed)}</span>
                  <button type="button" className="speed" disabled={speed === 1} title="Reset to 1x" onClick={() => onChange({...speeds, [section.id]: 1})}>
                    {speed.toFixed(2)}x
                  </button>
                </span>
              </div>
              <input
                type="range"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.05}
                value={speed}
                style={{'--from': `${Math.min(fill, ONE_X)}%`, '--to': `${Math.max(fill, ONE_X)}%`, '--one': `${ONE_X}%`} as CSSProperties}
                aria-label={`${section.label} speed`}
                aria-valuetext={`${speed.toFixed(2)} times speed`}
                onChange={(e) => onChange({...speeds, [section.id]: Number(e.target.value)})}
              />
            </li>
          );
        })}
      </ul>
      <p className="muted hint">Drag left to slow a section down, right to speed it up. Pacing is saved to pacing.json and applied by the next export. Your agent can bake it into the scene timings.</p>
    </div>
  );
}
