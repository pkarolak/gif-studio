import {buildPacing, pacedDuration} from '../../src/shared/pacing';
import {formatTime, type Manifest} from './api';

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
        <span>
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
          return (
            <li key={section.id}>
              <div className="pacing-head">
                <span>{section.label}</span>
                <span className="muted">
                  {formatTime(length / speed)} · {speed.toFixed(2)}x
                </span>
              </div>
              <input
                type="range"
                min={0.25}
                max={3}
                step={0.05}
                value={speed}
                aria-label={`${section.label} speed`}
                onChange={(e) => onChange({...speeds, [section.id]: Number(e.target.value)})}
              />
              <div className="pacing-scale muted">
                <span>Slower</span>
                <span>Faster</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted hint">Pacing is saved to pacing.json and applied by the next export. Your agent can bake it into the scene timings.</p>
    </div>
  );
}
