import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {buildPacing, pacedDuration, sceneToStudio, studioToScene} from '../../src/shared/pacing';
import {api, formatTime, sceneUrl, subscribe, type AssetDetail, type Manifest, type Note, type ProjectInfo, type RenderProgress, type ServerEvent} from './api';
import {NoteComposer, NotesPanel, type NumberedNote} from './Notes';
import {PacingPanel} from './Pacing';
import {Player, type SceneControl} from './Player';
import {Scrubber} from './Scrubber';
import {Select} from './Select';
import {VersionsPanel} from './Versions';

const WORKING = 'working';
const RATES = [0.25, 0.5, 1, 1.5, 2];
const FRAME_MS = 1000 / 30;
const PIN_WINDOW_MS = 350;

type Tab = 'notes' | 'pacing' | 'versions';

function initialParams() {
  const params = new URLSearchParams(location.search);
  return {asset: params.get('asset'), version: params.get('version')};
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [asset, setAsset] = useState<string | null>(initialParams().asset);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [viewing, setViewing] = useState<string>(initialParams().version ?? WORKING);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState<Tab>('notes');
  const [scope, setScope] = useState<'version' | 'all'>('version');
  const [draft, setDraft] = useState<{t: number; x: number; y: number} | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const [formats, setFormats] = useState({gif: true, mp4: true});
  const [exportOpen, setExportOpen] = useState(false);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [toast, setToast] = useState<{text: string; tone: 'ok' | 'error'} | null>(null);
  const controlRef = useRef<SceneControl | null>(null);
  const pacingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({text, tone});
    setTimeout(() => setToast((current) => (current?.text === text ? null : current)), 4000);
  }, []);

  const loadProject = useCallback(async () => {
    try {
      const info = await api.project();
      setProject(info);
      setProjectError(null);
      setAsset((current) => (current && info.assets.some((a) => a.asset === current) ? current : (info.assets[0]?.asset ?? null)));
    } catch (error) {
      setProjectError((error as Error).message);
    }
  }, []);

  const loadAsset = useCallback(async (name: string) => {
    const next = await api.asset(name);
    setDetail(next);
    setSpeeds(next.pacing);
    return next;
  }, []);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (!asset) return;
    setDetail(null);
    setManifest(null);
    void loadAsset(asset);
    const url = new URL(location.href);
    url.searchParams.set('asset', asset);
    history.replaceState(null, '', url);
  }, [asset, loadAsset]);

  useEffect(() => {
    const url = new URL(location.href);
    if (viewing === WORKING) url.searchParams.delete('version');
    else url.searchParams.set('version', viewing);
    history.replaceState(null, '', url);
  }, [viewing]);

  const versions = detail?.versions ?? [];
  const viewedVersion = viewing === WORKING ? null : (versions.find((v) => v.label === viewing) ?? null);
  const latest = versions.filter((v) => !v.archived).at(-1) ?? null;
  const noteVersion = viewedVersion?.n ?? latest?.n ?? 0;
  const viewingLabel = viewedVersion ? viewedVersion.label : 'Working copy';

  const segments = useMemo(() => (manifest ? buildPacing(manifest.duration, manifest.sections, speeds) : []), [manifest, speeds]);
  const total = manifest ? pacedDuration(segments) : 0;
  const sceneTime = manifest ? studioToScene(segments, time) : 0;

  const allNotes: NumberedNote[] = useMemo(
    () => [...(detail?.notes ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((note, i) => ({...note, number: i + 1})),
    [detail],
  );
  const shownNotes = useMemo(
    () => allNotes.filter((n) => scope === 'all' || n.version === noteVersion).sort((a, b) => a.t - b.t),
    [allNotes, scope, noteVersion],
  );

  useEffect(() => {
    if (manifest) controlRef.current?.seek(sceneTime);
  }, [sceneTime, manifest]);

  useEffect(() => {
    if (!playing || !total) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * rate;
      last = now;
      setTime((t) => (t + dt) % total);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate, total]);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === 'render-progress') {
        if (event.asset === asset) setProgress(event.progress);
        return;
      }
      if (event.type === 'render-done') {
        setProgress(null);
        void loadProject();
        if (event.asset === asset) {
          void loadAsset(event.asset).then(() => setViewing(event.result.version));
          notify(`Exported ${event.result.version}`);
        }
        return;
      }
      if (event.type === 'render-error') {
        setProgress(null);
        notify(`Export failed: ${event.error}`, 'error');
        return;
      }
      if (event.type === 'scene-changed') {
        if (event.asset === null || event.asset === asset) {
          if (viewing === WORKING) setReloadKey((k) => k + 1);
          void loadProject();
        } else void loadProject();
        return;
      }
      if (event.asset === asset) void loadAsset(event.asset);
    },
    [asset, viewing, loadAsset, loadProject, notify],
  );

  useEffect(() => subscribe(handleEvent), [handleEvent]);

  const handleReady = useCallback((control: SceneControl, next: Manifest) => {
    controlRef.current = control;
    setManifest(next);
  }, []);

  useEffect(() => {
    if (manifest) setTime((t) => Math.min(t, Math.max(0, total - 1)));
  }, [manifest, total]);

  const seekToNote = (note: Note) => {
    setPlaying(false);
    setSelected(note.id);
    setTime(sceneToStudio(segments, note.t));
  };

  const step = (direction: number, big: boolean) => {
    setPlaying(false);
    setTime((t) => Math.min(Math.max(t + direction * FRAME_MS * (big ? 10 : 1), 0), Math.max(0, total - 1)));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable], [data-select]')) return;
      if (event.key === ' ') {
        event.preventDefault();
        setDraft(null);
        setPlaying((p) => !p);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey);
      } else if (event.key === 'Home') setTime(0);
      else if (event.key === 'End') setTime(Math.max(0, total - 1));
      else if (event.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const updatePacing = (next: Record<string, number>) => {
    if (!asset) return;
    setSpeeds(next);
    clearTimeout(pacingTimer.current);
    pacingTimer.current = setTimeout(() => {
      api.setPacing(asset, next).catch((error: Error) => notify(error.message, 'error'));
    }, 300);
  };

  const startExport = async () => {
    if (!asset) return;
    const chosen = Object.entries(formats).filter(([, on]) => on).map(([f]) => f);
    if (!chosen.length) return notify('Pick at least one format', 'error');
    setExportOpen(false);
    try {
      await api.render(asset, chosen);
      setProgress({phase: 'snapshot', done: 0, total: 1});
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  };

  const saveDraft = async (text: string, attachments: string[]) => {
    if (!asset || !draft) return;
    const note = await api.addNote(asset, {version: noteVersion, t: draft.t, x: draft.x, y: draft.y, text, attachments});
    setDraft(null);
    setSelected(note.id);
    await loadAsset(asset);
  };

  const pins = shownNotes.filter((n) => Math.abs(n.t - sceneTime) <= PIN_WINDOW_MS || n.id === selected);

  if (projectError) {
    return (
      <div className="fatal">
        <h1>Can't reach Gif Studio</h1>
        <p>{projectError}</p>
        <p className="muted">Start it from your project with: npx gif-studio studio</p>
      </div>
    );
  }

  const assetInfo = project?.assets.find((a) => a.asset === asset);
  const rendering = progress !== null || Boolean(detail?.rendering);
  const progressPct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg className="logo" viewBox="0 0 28 24" width="28" height="24" aria-hidden>
            <rect className="logo-back" x="0" y="7" width="16" height="16" rx="5" fill="#FFC21A" />
            <rect className="logo-mid" x="5" y="4" width="16" height="16" rx="5" fill="#FF4FA3" />
            <rect x="10" y="1" width="16" height="16" rx="5" fill="#5B4BFF" />
            <path d="M16 5.8v6.4l5.2-3.2z" fill="#fff" />
          </svg>
          <span className="brand-name">Gif Studio</span>
          <span className="pro">PRO</span>
        </div>
        <div className="field">
          <span aria-hidden>Asset</span>
          <Select<string>
            label="Asset"
            value={asset ?? ''}
            onChange={setAsset}
            disabled={!project?.assets.length}
            options={(project?.assets ?? []).map((a) => ({value: a.asset, label: a.asset, meta: a.openNotes ? `${a.openNotes} open` : undefined, tone: 'open' as const}))}
          />
        </div>
        <div className="field">
          <span aria-hidden>Version</span>
          <Select<string>
            label="Version"
            value={viewing}
            onChange={setViewing}
            options={[{value: WORKING, label: 'Working copy'}, ...[...versions].reverse().map((v) => ({value: v.label, label: v.label, meta: v.archived ? 'archived' : undefined}))]}
          />
        </div>
        {assetInfo?.final && <span className="badge done">Shipped to final/</span>}
        <div className="spacer" />
        <div className="export">
          {rendering ? (
            <div className="render-progress" aria-live="polite">
              <span>{progress ? `${progress.phase.replace('-', ' ')} ${progressPct}%` : 'Rendering…'}</span>
              <div className="bar">
                <div style={{width: `${progressPct}%`}} />
              </div>
            </div>
          ) : (
            <button type="button" className="primary" disabled={!asset} onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}>
              Export
            </button>
          )}
          {exportOpen && (
            <div className="popover" role="dialog" aria-label="Export">
              <div className="popover-title">Render {latest ? `v${latest.n + 1}` : 'v1'} from the working copy</div>
              {(['gif', 'mp4'] as const).map((f) => (
                <label key={f} className="check">
                  <input type="checkbox" checked={formats[f]} onChange={() => setFormats((prev) => ({...prev, [f]: !prev[f]}))} />
                  {f.toUpperCase()}
                  <span className="muted">{f === 'gif' ? 'master, loops everywhere' : 'sharp, for the product'}</span>
                </label>
              ))}
              <p className="muted">Stills for every beat are saved too. Pacing from the Pacing tab is applied.</p>
              <button type="button" className="primary wide" onClick={startExport}>
                Render
              </button>
            </div>
          )}
        </div>
      </header>

      {!project ? (
        <div className="empty center">Loading…</div>
      ) : !asset ? (
        <div className="empty center">
          <h2>No assets yet</h2>
          <p className="muted">Ask your agent to make one, e.g. “make a marketing GIF of the signup flow”, or run npx gif-studio new my-asset.</p>
        </div>
      ) : (
        <main className="workspace">
          <section className="viewer">
            <Player
              src={sceneUrl(asset, viewedVersion)}
              label={`${asset} / ${viewing === WORKING ? 'working copy' : viewing}`}
              reloadKey={reloadKey}
              onReady={handleReady}
              onStageClick={(point) => {
                setPlaying(false);
                setSelected(null);
                setDraft({t: Math.round(sceneTime), ...point});
                setTab('notes');
              }}
            >
              {pins.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className={`pin${note.open ? '' : ' resolved'}${selected === note.id ? ' selected' : ''}`}
                  style={{left: `${note.x * 100}%`, top: `${note.y * 100}%`}}
                  title={note.text}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekToNote(note);
                  }}
                >
                  {note.number}
                </button>
              ))}
              {draft && (
                <div className="pin-draft" style={{left: `${draft.x * 100}%`, top: `${draft.y * 100}%`}}>
                  <span className="pin draft">+</span>
                  <div className={`composer-anchor${draft.x > 0.6 ? ' left' : ''}${draft.y > 0.55 ? ' up' : ''}`}>
                    <NoteComposer asset={asset} t={draft.t} onSave={saveDraft} onCancel={() => setDraft(null)} />
                  </div>
                </div>
              )}
            </Player>
            <div className="transport">
              <button type="button" className="icon" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)} disabled={!manifest}>
                {playing ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><rect x="3" y="2" width="3.5" height="12" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" /></svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M3 1.5v13L14 8z" fill="currentColor" /></svg>
                )}
              </button>
              <button type="button" className="icon" aria-label="Previous frame" onClick={() => step(-1, false)} disabled={!manifest}>
                ‹
              </button>
              <button type="button" className="icon" aria-label="Next frame" onClick={() => step(1, false)} disabled={!manifest}>
                ›
              </button>
              <span className="time">
                {formatTime(time)} <span className="muted">/ {formatTime(total)}</span>
              </span>
              {manifest && (
                <Scrubber
                  manifest={manifest}
                  segments={segments}
                  total={total}
                  time={time}
                  notes={shownNotes}
                  selectedNote={selected}
                  onScrubStart={() => {
                    setPlaying(false);
                    setDraft(null);
                  }}
                  onScrub={setTime}
                  onSelectNote={seekToNote}
                />
              )}
              <Select<number>
                className="rate"
                label="Playback speed"
                value={rate}
                onChange={setRate}
                placement="up"
                align="end"
                options={RATES.map((r) => ({value: r, label: `${r}x`}))}
              />
            </div>
            <div className="hints muted">Space play/pause · ←/→ one frame (Shift ×10) · click the frame to leave a note</div>
          </section>

          <aside className="sidebar">
            <div className="tabs" role="tablist">
              {(['notes', 'pacing', 'versions'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === 'notes' ? `Notes${shownNotes.filter((n) => n.open).length ? ` (${shownNotes.filter((n) => n.open).length})` : ''}` : t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            {tab === 'notes' && (
              <NotesPanel
                asset={asset}
                notes={shownNotes}
                scope={scope}
                onScope={setScope}
                viewingLabel={viewingLabel}
                selected={selected}
                onSelect={seekToNote}
                onToggleDone={(note) => void api.updateNote(asset, note.id, {done: !note.done}).then(() => loadAsset(asset))}
                onDelete={(note) => void api.deleteNote(asset, note.id).then(() => loadAsset(asset))}
              />
            )}
            {tab === 'pacing' && manifest && <PacingPanel manifest={manifest} speeds={speeds} onChange={updatePacing} />}
            {tab === 'versions' && project && <VersionsPanel assetsDir={project.assetsDir} versions={versions} viewing={viewing} onView={setViewing} />}
          </aside>
        </main>
      )}
      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
