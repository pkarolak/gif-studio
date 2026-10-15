import {useEffect, useRef, useState, type ClipboardEvent, type DragEvent} from 'react';
import {api, formatTime, type Note} from './api';

export type NumberedNote = Note & {number: number};

function imagesFrom(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && file.type.startsWith('image/')) files.push(file);
  }
  return files;
}

export function useAttachments(asset: string) {
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const add = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const {path} = await api.upload(asset, file);
        setAttachments((prev) => [...prev, path]);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const handlers = {
    onPaste: (event: ClipboardEvent) => {
      const files = imagesFrom(event.clipboardData?.items);
      if (files.length) {
        event.preventDefault();
        void add(files);
      }
    },
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDrop: (event: DragEvent) => {
      const files = imagesFrom(event.dataTransfer?.files);
      if (files.length) {
        event.preventDefault();
        void add(files);
      }
    },
  };
  return {attachments, setAttachments, uploading, handlers};
}

function Thumbs({asset, paths, onRemove}: {asset: string; paths: string[]; onRemove?(path: string): void}) {
  if (!paths.length) return null;
  return (
    <div className="thumbs">
      {paths.map((p) => (
        <span key={p} className="thumb">
          <a href={`/files/${encodeURIComponent(asset)}/${p}`} target="_blank" rel="noreferrer">
            <img src={`/files/${encodeURIComponent(asset)}/${p}`} alt="Attachment" />
          </a>
          {onRemove && (
            <button type="button" aria-label="Remove image" onClick={() => onRemove(p)}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

interface ComposerProps {
  asset: string;
  t: number;
  onSave(text: string, attachments: string[]): Promise<void>;
  onCancel(): void;
}

export function NoteComposer({asset, t, onSave, onCancel}: ComposerProps) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const {attachments, setAttachments, uploading, handlers} = useAttachments(asset);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const save = async () => {
    if (!text.trim() && !attachments.length) return;
    setSaving(true);
    try {
      await onSave(text.trim(), attachments);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="composer" onClick={(e) => e.stopPropagation()} {...handlers}>
      <div className="composer-head">Note at {formatTime(t)}</div>
      <textarea
        ref={ref}
        value={text}
        placeholder="One change per note, e.g. “hold this state 500ms longer”. Paste or drop images."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') onCancel();
          e.stopPropagation();
        }}
      />
      <Thumbs asset={asset} paths={attachments} onRemove={(p) => setAttachments((prev) => prev.filter((x) => x !== p))} />
      <div className="composer-actions">
        <span className="muted">{uploading ? 'Uploading…' : '⌘↵ to save'}</span>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving || uploading > 0 || (!text.trim() && !attachments.length)} onClick={save}>
          Add note
        </button>
      </div>
    </div>
  );
}

function statusOf(note: Note): {label: string; tone: string} {
  if (note.done) return {label: 'Done', tone: 'done'};
  if (note.coveredIn !== null) return {label: `Covered in v${note.coveredIn}`, tone: 'covered'};
  return {label: 'Open', tone: 'open'};
}

interface NotesPanelProps {
  asset: string;
  notes: NumberedNote[];
  scope: 'version' | 'all';
  onScope(scope: 'version' | 'all'): void;
  viewingLabel: string;
  selected: string | null;
  onSelect(note: Note): void;
  onToggleDone(note: Note): void;
  onDelete(note: Note): void;
}

export function NotesPanel({asset, notes, scope, onScope, viewingLabel, selected, onSelect, onToggleDone, onDelete}: NotesPanelProps) {
  const open = notes.filter((n) => n.open).length;
  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="segmented" role="group" aria-label="Which notes">
          <button type="button" aria-pressed={scope === 'version'} onClick={() => onScope('version')}>
            {viewingLabel}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => onScope('all')}>
            All versions
          </button>
        </div>
        <span className="muted">{open} open</span>
      </div>
      {notes.length === 0 ? (
        <div className="empty">
          <p>Click anywhere on the frame to pin a note to that moment.</p>
          <p className="muted">Then tell your agent: “apply notes from {viewingLabel === 'Working copy' ? 'the latest version' : viewingLabel}”.</p>
        </div>
      ) : (
        <ol className="note-list">
          {notes.map((note) => {
            const status = statusOf(note);
            return (
              <li key={note.id} className={`note-item${selected === note.id ? ' selected' : ''}${note.open ? '' : ' resolved'}`}>
                <button type="button" className="note-main" onClick={() => onSelect(note)}>
                  <span className="note-number">{note.number}</span>
                  <span className="note-body">
                    <span className="note-meta">
                      <span>{formatTime(note.t)}</span>
                      <span>v{note.version}</span>
                      <span className={`badge ${status.tone}`}>{status.label}</span>
                    </span>
                    <span className="note-text">{note.text || <em className="muted">Image only</em>}</span>
                  </span>
                </button>
                <Thumbs asset={asset} paths={note.attachments} />
                <div className="note-actions">
                  <label className="check">
                    <input type="checkbox" checked={note.done} onChange={() => onToggleDone(note)} />
                    Done
                  </label>
                  <button type="button" className="ghost small" onClick={() => onDelete(note)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
