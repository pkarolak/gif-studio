import {useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react';
import type {Manifest} from './api';

export interface SceneControl {
  seek(t: number): void;
}

interface SceneWindow extends Window {
  __scene?: Manifest & {seek(t: number): void | Promise<void>; ready?: Promise<unknown>};
}

interface PlayerProps {
  src: string;
  reloadKey: number;
  onReady(control: SceneControl, manifest: Manifest): void;
  onStageClick(point: {x: number; y: number}): void;
  label?: string;
  children?: ReactNode;
}

export function Player({src, reloadKey, onReady, onStageClick, label, children}: PlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({width: 960, height: 540});
  const [scale, setScale] = useState(1);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const pad = 80;
      const w = container.clientWidth - pad;
      const h = container.clientHeight - pad;
      setScale(Math.max(0.1, Math.min(w / size.width, h / size.height, 2)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [size]);

  useEffect(() => {
    setLoading(true);
    setErrors([]);
  }, [src, reloadKey]);

  const handleLoad = useCallback(async () => {
    const win = iframeRef.current?.contentWindow as SceneWindow | null;
    if (!win) return;
    const captured: string[] = [];
    win.addEventListener('error', (event) => {
      captured.push(event.message);
      setErrors([...captured]);
    });
    win.addEventListener('unhandledrejection', (event) => {
      captured.push(String((event.reason as Error)?.message ?? event.reason));
      setErrors([...captured]);
    });
    const deadline = Date.now() + 15_000;
    while (!win.__scene && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const scene = win.__scene;
    if (!scene) {
      setErrors((prev) => [...prev, 'scene.html never defined window.__scene. Make sure the scene calls scene.done().']);
      setLoading(false);
      return;
    }
    try {
      await scene.ready;
    } catch (error) {
      setErrors((prev) => [...prev, `Scene failed to get ready: ${(error as Error).message}`]);
    }
    const manifest: Manifest = {
      width: scene.width,
      height: scene.height,
      duration: scene.duration,
      sections: scene.sections ?? [],
      beats: scene.beats ?? [],
    };
    setSize({width: manifest.width, height: manifest.height});
    setLoading(false);

    let busy = false;
    let next: number | null = null;
    const pump = async () => {
      busy = true;
      while (next !== null) {
        const t = next;
        next = null;
        try {
          await scene.seek(t);
        } catch (error) {
          setErrors((prev) => (prev.length > 20 ? prev : [...prev, (error as Error).message]));
        }
      }
      busy = false;
    };
    onReadyRef.current(
      {
        seek: (t) => {
          next = t;
          if (!busy) void pump();
        },
      },
      manifest,
    );
  }, []);

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onStageClick({x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height});
  };

  return (
    <div className="player" ref={containerRef}>
      <div className="stage" style={{width: size.width * scale, height: size.height * scale}}>
        {label && (
          <span className="frame-label">
            {label}
            <span>
              {size.width} × {size.height}
            </span>
          </span>
        )}
        <iframe
          key={`${src}#${reloadKey}`}
          ref={iframeRef}
          title="Scene"
          src={`${src}?studio=1&r=${reloadKey}`}
          onLoad={handleLoad}
          style={{width: size.width, height: size.height, transform: `scale(${scale})`}}
        />
        <div className="stage-overlay" onClick={handleClick}>
          {children}
        </div>
        {loading && <div className="stage-loading">Loading scene…</div>}
      </div>
      {errors.length > 0 && (
        <div className="scene-errors" role="alert">
          <strong>Scene errors</strong>
          {errors.slice(-4).map((error, i) => (
            <div key={i}>{error}</div>
          ))}
        </div>
      )}
    </div>
  );
}
