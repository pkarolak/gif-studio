import {filesUrl, formatBytes, formatTime, type Version} from './api';

interface VersionsPanelProps {
  assetsDir: string;
  versions: Version[];
  viewing: string;
  onView(label: string): void;
}

export function VersionsPanel({assetsDir, versions, viewing, onView}: VersionsPanelProps) {
  if (!versions.length) {
    return (
      <div className="panel empty">
        <p>No versions yet.</p>
        <p className="muted">Export renders the working copy as v1, with a GIF, an MP4 and a still per beat.</p>
      </div>
    );
  }
  return (
    <div className="panel">
      <ul className="version-list">
        {[...versions].reverse().map((version) => (
          <li key={version.label} className={viewing === version.label ? 'selected' : ''}>
            <div className="version-head">
              <button type="button" className="link" onClick={() => onView(version.label)}>
                {version.label}
              </button>
              {version.archived && <span className="badge covered">Archived</span>}
              <span className="muted">
                {version.durationMs !== null ? formatTime(version.durationMs) : ''}
                {version.createdAt ? ` · ${new Date(version.createdAt).toLocaleString()}` : ''}
              </span>
            </div>
            <div className="outputs">
              {version.outputs.map((output) => (
                <a key={output.file} href={filesUrl(assetsDir, output.file)} target="_blank" rel="noreferrer" download>
                  {output.format.toUpperCase()} <span className="muted">{formatBytes(output.bytes)}</span>
                </a>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted hint">Happy with a version? Tell your agent “promote {versions.filter((v) => !v.archived).at(-1)?.label ?? 'vN'}” to ship it to final/.</p>
    </div>
  );
}
