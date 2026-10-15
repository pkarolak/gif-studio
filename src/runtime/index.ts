/**
 * gif-studio scene runtime. Every scene is a pure function of time: build a timeline once,
 * then `seek(t)` recomputes the whole frame. Load it in a scene with
 * `import {createScene} from '/__studio/runtime.js'`.
 */

export interface Section {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface Beat {
  t: number;
  label: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Ease = (p: number) => number;

export const ease = {
  linear: (p: number) => p,
  in: (p: number) => p * p * p,
  out: (p: number) => 1 - Math.pow(1 - p, 3),
  inOut: (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  outBack: (p: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
  spring: (p: number) => 1 - Math.cos(p * Math.PI * 4.5) * Math.exp(-p * 6),
} satisfies Record<string, Ease>;

export type EaseName = keyof typeof ease;

type Props = Record<string, number>;

interface Track {
  target: object;
  start: number;
  dur: number;
  props: string[];
  value(prop: string, p: number): number;
  from: Props;
  ease: Ease;
}

interface CallTrack {
  start: number;
  dur: number;
  fn: (p: number, t: number) => void | Promise<void>;
}

const NUMERIC_DEFAULTS: Props = {x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, blur: 0};

export function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const resolveEase = (e?: Ease | EaseName): Ease => (typeof e === 'function' ? e : ease[e ?? 'inOut']);

export interface TweenOptions {
  at: number;
  dur?: number;
  from?: Props;
  to: Props;
  ease?: Ease | EaseName;
}

export interface SceneOptions {
  width: number;
  height: number;
  duration?: number;
  root?: HTMLElement;
  background?: string;
}

export interface SceneHandle {
  contract: number;
  width: number;
  height: number;
  duration: number;
  sections: Section[];
  beats: Beat[];
  seek(t: number): void | Promise<void>;
  ready: Promise<unknown>;
}

declare global {
  interface Window {
    __scene?: SceneHandle;
  }
}

export class Scene {
  readonly width: number;
  readonly height: number;
  readonly stage: HTMLElement;
  readonly sections: Section[] = [];
  readonly beats: Beat[] = [];
  duration: number;
  private tracks: Track[] = [];
  private calls: CallTrack[] = [];
  private appliers = new Map<object, (state: Props) => void>();
  private state = new Map<object, Props>();
  private pending: Promise<unknown>[] = [];
  private cameras: Camera[] = [];
  private cursors: Cursor[] = [];

  constructor(options: SceneOptions) {
    this.width = options.width;
    this.height = options.height;
    this.duration = options.duration ?? 0;
    const stage = options.root ?? document.getElementById('stage') ?? document.body.appendChild(document.createElement('div'));
    stage.id ||= 'stage';
    Object.assign(stage.style, {
      position: 'relative',
      width: `${this.width}px`,
      height: `${this.height}px`,
      overflow: 'hidden',
      ...(options.background ? {background: options.background} : {}),
    });
    document.documentElement.style.margin = '0';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    this.stage = stage;
  }

  el<K extends keyof HTMLElementTagNameMap>(tag: K, options: {parent?: HTMLElement; className?: string; style?: Partial<CSSStyleDeclaration>; html?: string; text?: string} = {}): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.style) Object.assign(node.style, options.style);
    if (options.html !== undefined) node.innerHTML = options.html;
    if (options.text !== undefined) node.textContent = options.text;
    (options.parent ?? this.stage).appendChild(node);
    return node;
  }

  section(id: string, label: string, start: number, end: number): this {
    this.sections.push({id, label, start, end});
    this.extend(end);
    return this;
  }

  beat(t: number, label: string): this {
    this.beats.push({t, label});
    this.extend(t);
    return this;
  }

  extend(t: number): void {
    if (t > this.duration) this.duration = t;
  }

  register(target: object, apply: (state: Props) => void): void {
    this.appliers.set(target, apply);
  }

  addTrack(track: Track): void {
    this.tracks.push(track);
    this.extend(track.start + track.dur);
    if (track.target instanceof HTMLElement && !this.appliers.has(track.target)) {
      this.register(track.target, (s) => applyElement(track.target as HTMLElement, s));
    }
  }

  valueAt(targetObj: object, prop: string, t: number): number | undefined {
    let active: Track | undefined;
    for (const track of this.tracks) {
      if (track.target !== targetObj || !track.props.includes(prop) || track.start > t) continue;
      if (!active || track.start >= active.start) active = track;
    }
    if (!active) return undefined;
    const p = active.dur <= 0 ? 1 : clamp01((t - active.start) / active.dur);
    return active.value(prop, active.ease(p));
  }

  tween(targetObj: object, options: TweenOptions): number {
    const dur = options.dur ?? 600;
    const to = options.to;
    const props = Object.keys(to);
    const from: Props = {};
    for (const prop of props) {
      const value = options.from?.[prop] ?? this.valueAt(targetObj, prop, options.at) ?? NUMERIC_DEFAULTS[prop];
      if (value !== undefined) from[prop] = value;
    }
    this.addTrack({
      target: targetObj,
      start: options.at,
      dur,
      props,
      from,
      ease: resolveEase(options.ease),
      value: (prop, p) => {
        const a = from[prop] ?? NaN;
        const b = to[prop]!;
        return Number.isNaN(a) ? b : a + (b - a) * p;
      },
    });
    return options.at + dur;
  }

  set(targetObj: object, at: number, props: Props): number {
    return this.tween(targetObj, {at, dur: 0, to: props});
  }

  fadeIn(targetObj: object, at: number, dur = 300, offset: Props = {}): number {
    const rest = Object.fromEntries(Object.keys(offset).map((k) => [k, NUMERIC_DEFAULTS[k] ?? 0]));
    return this.tween(targetObj, {at, dur, from: {opacity: 0, ...offset}, to: {opacity: 1, ...rest}, ease: 'out'});
  }

  fadeOut(targetObj: object, at: number, dur = 300): number {
    return this.tween(targetObj, {at, dur, from: {opacity: 1}, to: {opacity: 0}, ease: 'in'});
  }

  path(targetObj: object, options: {at: number; dur?: number; from: {x: number; y: number}; to: {x: number; y: number}; curve?: number; ease?: Ease | EaseName; seed?: number}): number {
    const dur = options.dur ?? 800;
    const {from, to} = options;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const random = rng(options.seed ?? Math.round(from.x * 7 + to.y * 13));
    const bend = (options.curve ?? 0.22) * (random() > 0.5 ? 1 : -1);
    const control = {x: from.x + dx * 0.5 - dy * bend, y: from.y + dy * 0.5 + dx * bend};
    this.addTrack({
      target: targetObj,
      start: options.at,
      dur,
      props: ['x', 'y'],
      from: {x: from.x, y: from.y},
      ease: resolveEase(options.ease ?? 'inOut'),
      value: (prop, p) => {
        const a = prop === 'x' ? from.x : from.y;
        const c = prop === 'x' ? control.x : control.y;
        const b = prop === 'x' ? to.x : to.y;
        return (1 - p) * (1 - p) * a + 2 * (1 - p) * p * c + p * p * b;
      },
    });
    return options.at + dur;
  }

  call(at: number, dur: number, fn: (p: number, t: number) => void | Promise<void>): number {
    this.calls.push({start: at, dur, fn});
    this.extend(at + dur);
    return at + dur;
  }

  text(targetEl: HTMLElement, at: number, value: string): number {
    const initial = targetEl.textContent ?? '';
    return this.call(at, 0, (p) => {
      targetEl.textContent = p >= 1 ? value : initial;
    });
  }

  type(targetEl: HTMLElement, options: {at: number; text: string; cps?: number; seed?: number; caret?: boolean}): number {
    const random = rng(options.seed ?? options.text.length * 31);
    const base = 1000 / (options.cps ?? 14);
    const times: number[] = [];
    let t = 0;
    for (const char of options.text) {
      t += base * (0.55 + random() * 0.9);
      if (/[ ,.;:!?]/.test(char)) t += base * (0.4 + random() * 1.2);
      times.push(t);
    }
    const total = t;
    const caret = options.caret ?? true;
    const initial = targetEl.textContent ?? '';
    this.call(options.at, total + 500, (_p, now) => {
      const elapsed = now - options.at;
      if (elapsed < 0) {
        targetEl.textContent = initial;
        return;
      }
      let count = 0;
      while (count < times.length && times[count]! <= elapsed) count++;
      const blink = caret && elapsed < total + 450 && Math.floor(now / 450) % 2 === 0;
      targetEl.innerHTML = `${escapeHtml(options.text.slice(0, count))}${caret && elapsed <= total + 450 ? `<span style="display:inline-block;width:0.08em;height:1em;margin-left:1px;vertical-align:-0.12em;background:currentColor;opacity:${blink || count < times.length ? 1 : 0}"></span>` : ''}`;
    });
    return options.at + total;
  }

  camera(viewport: HTMLElement, options: CameraOptions): Camera {
    const camera = new Camera(this, viewport, options);
    this.cameras.push(camera);
    return camera;
  }

  cursor(options: CursorOptions = {}): Cursor {
    const cursor = new Cursor(this, options);
    this.cursors.push(cursor);
    return cursor;
  }

  caption(textValue: string, options: {at: number; dur: number; position?: 'top' | 'bottom'; style?: Partial<CSSStyleDeclaration>}): HTMLElement {
    const node = this.el('div', {
      text: textValue,
      style: {
        position: 'absolute',
        left: '50%',
        [options.position === 'top' ? 'top' : 'bottom']: '6%',
        transform: 'translateX(-50%)',
        padding: '10px 18px',
        borderRadius: '999px',
        background: 'rgba(17, 20, 32, 0.86)',
        color: '#fff',
        font: `600 ${Math.round(this.height * 0.034)}px/1.2 var(--font, system-ui, sans-serif)`,
        whiteSpace: 'nowrap',
        zIndex: '50',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,.4)',
        ...options.style,
      },
    });
    const wrapper = node;
    this.set(wrapper, 0, {opacity: 0});
    this.tween(wrapper, {at: options.at, dur: 300, from: {opacity: 0, y: 10}, to: {opacity: 1, y: 0}, ease: 'out'});
    this.tween(wrapper, {at: options.at + options.dur - 250, dur: 250, from: {opacity: 1}, to: {opacity: 0}, ease: 'in'});
    applyElementBase(wrapper, 'translateX(-50%)');
    return node;
  }

  image(src: string, options: {parent?: HTMLElement; style?: Partial<CSSStyleDeclaration>} = {}): HTMLImageElement {
    const img = this.el('img', {parent: options.parent, style: {position: 'absolute', left: '0', top: '0', display: 'block', ...options.style}});
    img.decoding = 'sync';
    img.src = src;
    this.pending.push(img.decode().catch(() => undefined));
    return img;
  }

  footage(manifest: FootageManifest, options: {base: string; at: number; parent?: HTMLElement; from?: number; to?: number; rate?: number; style?: Partial<CSSStyleDeclaration>}): {element: HTMLImageElement; end: number} {
    const first = options.from ?? 0;
    const last = Math.min(options.to ?? manifest.frameCount - 1, manifest.frameCount - 1);
    const rate = options.rate ?? 1;
    const frameUrl = (i: number) => `${options.base}${manifest.framesDir}/${String(i + 1).padStart(5, '0')}.jpg`;
    const img = this.image(frameUrl(first), {parent: options.parent, style: {width: `${manifest.width}px`, height: `${manifest.height}px`, ...options.style}});
    const span = ((last - first + 1) / manifest.fps / rate) * 1000;
    let current = first;
    this.call(options.at, span, (_p, now) => {
      const index = Math.min(last, Math.max(first, first + Math.floor(((now - options.at) / 1000) * manifest.fps * rate)));
      if (index === current) return;
      current = index;
      img.src = frameUrl(index);
      return img.decode().catch(() => undefined);
    });
    return {element: img, end: options.at + span};
  }

  plates(manifest: PlatesManifest, options: {base: string; parent: HTMLElement}): HTMLImageElement[] {
    return manifest.plates.map((plate, i) => {
      const img = this.image(`${options.base}${plate.file}`, {
        parent: options.parent,
        style: {width: `${manifest.viewport.width}px`, height: `${manifest.viewport.height}px`},
      });
      this.set(img, 0, {opacity: i === 0 ? 1 : 0});
      return img;
    });
  }

  crossfade(from: HTMLElement | undefined, to: HTMLElement, at: number, dur = 260): number {
    this.tween(to, {at, dur, from: {opacity: 0}, to: {opacity: 1}, ease: 'inOut'});
    if (from) this.tween(from, {at: at + dur, dur: 0, to: {opacity: 0}});
    return at + dur;
  }

  private compute(t: number): void {
    const byTargetProp = new Map<object, Map<string, Track[]>>();
    for (const track of this.tracks) {
      let props = byTargetProp.get(track.target);
      if (!props) byTargetProp.set(track.target, (props = new Map()));
      for (const prop of track.props) {
        let list = props.get(prop);
        if (!list) props.set(prop, (list = []));
        list.push(track);
      }
    }
    this.state.clear();
    for (const [targetObj, props] of byTargetProp) {
      const values: Props = {};
      for (const [prop, list] of props) {
        let active: Track | undefined;
        for (const track of list) if (track.start <= t) active = !active || track.start >= active.start ? track : active;
        if (!active) {
          const first = list.reduce((a, b) => (b.start < a.start ? b : a));
          values[prop] = first.from[prop] ?? first.value(prop, 0);
          continue;
        }
        const p = active.dur <= 0 ? 1 : clamp01((t - active.start) / active.dur);
        values[prop] = active.value(prop, active.ease(p));
      }
      this.state.set(targetObj, values);
    }
  }

  stateOf(targetObj: object): Props {
    return this.state.get(targetObj) ?? {};
  }

  seek(t: number): void | Promise<void> {
    this.compute(t);
    for (const camera of this.cameras) camera.apply(this.stateOf(camera));
    for (const [targetObj, apply] of this.appliers) {
      if (targetObj instanceof Camera || targetObj instanceof Cursor) continue;
      const s = this.state.get(targetObj);
      if (s) apply(s);
    }
    for (const cursor of this.cursors) cursor.apply(this.stateOf(cursor));
    const results: Promise<unknown>[] = [];
    for (const call of [...this.calls].sort((a, b) => a.start - b.start)) {
      const p = call.dur <= 0 ? (t >= call.start ? 1 : 0) : clamp01((t - call.start) / call.dur);
      const result = call.fn(p, t);
      if (result instanceof Promise) results.push(result);
    }
    if (results.length) return Promise.all(results).then(() => undefined);
  }

  done(options: {duration?: number; loop?: boolean} = {}): SceneHandle {
    if (options.duration) this.duration = options.duration;
    const ready = Promise.all([document.fonts?.ready, ...this.pending]);
    const handle: SceneHandle = {
      contract: 1,
      width: this.width,
      height: this.height,
      duration: this.duration,
      sections: [...this.sections].sort((a, b) => a.start - b.start),
      beats: [...this.beats].sort((a, b) => a.t - b.t),
      seek: (t) => this.seek(t),
      ready,
    };
    window.__scene = handle;
    void ready.then(() => this.seek(0));
    autoplay(handle);
    return handle;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
}

const baseTransforms = new WeakMap<HTMLElement, string>();

function applyElementBase(element: HTMLElement, base: string): void {
  baseTransforms.set(element, base);
}

function applyElement(element: HTMLElement, s: Props): void {
  const parts: string[] = [];
  const base = baseTransforms.get(element);
  if (base) parts.push(base);
  if (s.x !== undefined || s.y !== undefined) parts.push(`translate(${s.x ?? 0}px, ${s.y ?? 0}px)`);
  if (s.scale !== undefined) parts.push(`scale(${s.scale})`);
  if (s.scaleX !== undefined || s.scaleY !== undefined) parts.push(`scale(${s.scaleX ?? 1}, ${s.scaleY ?? 1})`);
  if (s.rotate !== undefined) parts.push(`rotate(${s.rotate}deg)`);
  if (parts.length) element.style.transform = parts.join(' ');
  if (s.opacity !== undefined) element.style.opacity = String(s.opacity);
  if (s.blur !== undefined) element.style.filter = s.blur > 0 ? `blur(${s.blur}px)` : '';
  if (s.width !== undefined) element.style.width = `${s.width}px`;
  if (s.height !== undefined) element.style.height = `${s.height}px`;
  if (s.left !== undefined) element.style.left = `${s.left}px`;
  if (s.top !== undefined) element.style.top = `${s.top}px`;
  if (s.clip !== undefined) element.style.clipPath = `inset(0 ${100 - s.clip}% 0 0)`;
}

export interface CameraOptions {
  worldWidth: number;
  worldHeight: number;
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover';
}

export class Camera {
  readonly world: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly mode: 'contain' | 'cover';
  private current = {cx: 0, cy: 0, zoom: 1};

  constructor(
    private readonly scene: Scene,
    readonly viewport: HTMLElement,
    options: CameraOptions,
  ) {
    this.mode = options.fit ?? 'contain';
    this.width = options.width ?? (viewport.clientWidth || parseFloat(viewport.style.width) || scene.width);
    this.height = options.height ?? (viewport.clientHeight || parseFloat(viewport.style.height) || scene.height);
    this.worldWidth = options.worldWidth;
    this.worldHeight = options.worldHeight;
    viewport.style.overflow = 'hidden';
    if (getComputedStyle(viewport).position === 'static') viewport.style.position = 'relative';
    this.world = scene.el('div', {parent: viewport, style: {position: 'absolute', left: '0', top: '0', width: `${this.worldWidth}px`, height: `${this.worldHeight}px`, transformOrigin: '0 0'}});
    const fit = this.fitState();
    scene.set(this, 0, fit);
    scene.register(this, (s) => this.apply(s));
  }

  fitZoom(): number {
    const pick = this.mode === 'cover' ? Math.max : Math.min;
    return pick(this.width / this.worldWidth, this.height / this.worldHeight);
  }

  private clampCenter(x: number, y: number, zoom: number): {cx: number; cy: number} {
    const halfW = this.width / zoom / 2;
    const halfH = this.height / zoom / 2;
    const cx = this.worldWidth / 2 <= halfW ? this.worldWidth / 2 : Math.min(Math.max(x, halfW), this.worldWidth - halfW);
    const cy = this.worldHeight / 2 <= halfH ? this.worldHeight / 2 : Math.min(Math.max(y, halfH), this.worldHeight - halfH);
    return {cx, cy};
  }

  overview(at: number, dur = 700, around?: Box): number {
    const zoom = this.fitZoom();
    const point = around ? {x: around.x + around.width / 2, y: around.y + around.height / 2} : {x: this.worldWidth / 2, y: this.worldHeight / 2};
    return this.to(at, dur, {...this.clampCenter(point.x, point.y, zoom), zoom});
  }

  fitState(): Props {
    return {cx: this.worldWidth / 2, cy: this.worldHeight / 2, zoom: this.fitZoom()};
  }

  to(at: number, dur: number, view: {cx?: number; cy?: number; zoom?: number}, easeName: Ease | EaseName = 'inOut'): number {
    return this.scene.tween(this, {at, dur, to: {...this.fitState(), ...view}, ease: easeName});
  }

  fit(at: number, dur = 700): number {
    return this.to(at, dur, this.fitState());
  }

  focus(at: number, dur: number, box: Box, options: {padding?: number; maxZoom?: number; minZoom?: number} = {}): number {
    const padding = options.padding ?? 2.6;
    const fit = this.fitZoom();
    const zoom = Math.max(options.minZoom ?? fit, Math.min(options.maxZoom ?? fit * 1.8, this.width / (box.width * padding), this.height / (box.height * padding)));
    return this.to(at, dur, {...this.clampCenter(box.x + box.width / 2, box.y + box.height / 2, zoom), zoom});
  }

  worldToScreen(point: {x: number; y: number}): {x: number; y: number} {
    const {cx, cy, zoom} = this.current;
    const offset = viewportOffset(this.viewport, this.scene.stage);
    return {x: offset.x + this.width / 2 + (point.x - cx) * zoom, y: offset.y + this.height / 2 + (point.y - cy) * zoom};
  }

  get zoom(): number {
    return this.current.zoom;
  }

  apply(s: Props): void {
    this.current = {cx: s.cx ?? this.current.cx, cy: s.cy ?? this.current.cy, zoom: s.zoom ?? this.current.zoom};
    const {cx, cy, zoom} = this.current;
    this.world.style.transform = `translate(${this.width / 2 - cx * zoom}px, ${this.height / 2 - cy * zoom}px) scale(${zoom})`;
  }
}

function viewportOffset(viewport: HTMLElement, stage: HTMLElement): {x: number; y: number} {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = viewport;
  while (node && node !== stage) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return {x, y};
}

export interface CursorOptions {
  name?: string;
  color?: string;
  camera?: Camera;
  start?: {x: number; y: number};
  size?: number;
}

export class Cursor {
  readonly element: HTMLElement;
  private readonly ripple: HTMLElement;
  private last: {x: number; y: number; t: number};
  private readonly camera?: Camera;

  constructor(
    private readonly scene: Scene,
    options: CursorOptions,
  ) {
    const color = options.color ?? '#4262FF';
    const size = options.size ?? Math.max(18, Math.round(scene.height * 0.045));
    this.camera = options.camera;
    this.element = scene.el('div', {style: {position: 'absolute', left: '0', top: '0', zIndex: '40', pointerEvents: 'none', willChange: 'transform'}});
    this.ripple = scene.el('div', {
      parent: this.element,
      style: {position: 'absolute', left: `${-size * 0.6}px`, top: `${-size * 0.6}px`, width: `${size * 1.2}px`, height: `${size * 1.2}px`, borderRadius: '50%', background: color, opacity: '0'},
    });
    const arrow = scene.el('div', {
      parent: this.element,
      html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.25))"><path d="M4 2.5 20 11l-7.2 1.8L9.6 20z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
      style: {position: 'absolute', left: '-3px', top: '-2px', transformOrigin: '3px 2px'},
    });
    if (options.name) {
      scene.el('div', {
        parent: this.element,
        text: options.name,
        style: {position: 'absolute', left: `${size * 0.75}px`, top: `${size * 0.8}px`, padding: '2px 8px', borderRadius: '6px', background: color, color: '#fff', font: `600 ${Math.round(size * 0.55)}px/1.4 var(--font, system-ui, sans-serif)`, whiteSpace: 'nowrap'},
      });
    }
    this.arrow = arrow;
    this.last = {...(options.start ?? {x: scene.width * 0.85, y: scene.height * 1.1}), t: 0};
    scene.set(this, 0, {x: this.last.x, y: this.last.y, press: 1, visible: 1});
    scene.set(this.ripple, 0, {opacity: 0, scale: 0});
    scene.register(this, (s) => this.apply(s));
  }

  private readonly arrow: HTMLElement;

  get position(): {x: number; y: number} {
    return {x: this.last.x, y: this.last.y};
  }

  moveTo(at: number, dur: number, point: {x: number; y: number}, options: {curve?: number} = {}): number {
    const end = this.scene.path(this, {at, dur, from: {x: this.last.x, y: this.last.y}, to: point, curve: options.curve});
    this.last = {...point, t: end};
    return end;
  }

  moveToBox(at: number, dur: number, box: Box, options: {curve?: number; anchor?: {x: number; y: number}} = {}): number {
    const anchor = options.anchor ?? {x: 0.5, y: 0.55};
    return this.moveTo(at, dur, {x: box.x + box.width * anchor.x, y: box.y + box.height * anchor.y}, options);
  }

  click(at: number): number {
    this.scene.tween(this, {at, dur: 110, from: {press: 1}, to: {press: 0.82}, ease: 'out'});
    this.scene.tween(this, {at: at + 110, dur: 160, from: {press: 0.82}, to: {press: 1}, ease: 'out'});
    this.scene.tween(this.ripple, {at, dur: 450, from: {opacity: 0.35, scale: 0.2}, to: {opacity: 0, scale: 1.6}, ease: 'out'});
    return at + 280;
  }

  hide(at: number, dur = 200): number {
    return this.scene.tween(this, {at, dur, from: {visible: 1}, to: {visible: 0}});
  }

  show(at: number, dur = 200): number {
    return this.scene.tween(this, {at, dur, from: {visible: 0}, to: {visible: 1}});
  }

  apply(s: Props): void {
    const world = {x: s.x ?? this.last.x, y: s.y ?? this.last.y};
    const screen = this.camera ? this.camera.worldToScreen(world) : world;
    this.element.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
    this.element.style.opacity = String(s.visible ?? 1);
    this.arrow.style.transform = `scale(${s.press ?? 1})`;
  }
}

export interface PlateAction {
  type: 'click' | 'hover' | 'type' | 'press' | 'scroll';
  box?: Box;
  text?: string;
  key?: string;
  label?: string;
  fromY?: number;
  toY?: number;
}

export interface Plate {
  index: number;
  file: string;
  url: string;
  beat?: string;
  caption?: string;
  hold?: number;
  action?: PlateAction;
}

export interface PlatesManifest {
  journey: string;
  title: string;
  viewport: {width: number; height: number};
  scale: number;
  plates: Plate[];
}

export interface FootageManifest {
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  framesDir: string;
  markers: Array<{t: number; label: string; step: number}>;
}

export interface WalkthroughOptions {
  base: string;
  viewport: HTMLElement;
  cursor?: CursorOptions;
  zoom?: boolean;
  captions?: boolean;
  hold?: number;
  moveDuration?: number;
  endHold?: number;
  loop?: boolean;
  typingCps?: number;
  inputStyle?: Partial<CSSStyleDeclaration>;
  start?: number;
  fit?: 'contain' | 'cover';
}

export interface Walkthrough {
  camera: Camera;
  cursor: Cursor;
  images: HTMLImageElement[];
  end: number;
}

export function walkthrough(scene: Scene, manifest: PlatesManifest, options: WalkthroughOptions): Walkthrough {
  const camera = scene.camera(options.viewport, {worldWidth: manifest.viewport.width, worldHeight: manifest.viewport.height, fit: options.fit});
  const firstBox = manifest.plates.find((p) => p.action?.box)?.action?.box;
  if (camera.mode === 'cover' && firstBox) camera.overview(0, 0, firstBox);
  const images = scene.plates(manifest, {base: options.base, parent: camera.world});
  const cursor = scene.cursor({...options.cursor, camera, start: options.cursor?.start ?? {x: manifest.viewport.width * 0.82, y: manifest.viewport.height * 1.05}});
  const hold = options.hold ?? 800;
  const move = options.moveDuration ?? 850;
  const zoom = options.zoom ?? true;
  let t = options.start ?? 0;

  manifest.plates.forEach((plate, i) => {
    const sectionStart = t;
    const action = plate.action;
    const label = plate.beat ?? (i === 0 ? manifest.title : action?.label ?? `Step ${i + 1}`);
    t += plate.hold ?? hold;
    scene.beat(t - 60, label);
    if (options.captions !== false && plate.caption) scene.caption(plate.caption, {at: sectionStart + 150, dur: Math.max(1600, (plate.hold ?? hold) + move + 600)});
    const next = images[i + 1];

    if (action && (action.type === 'click' || action.type === 'hover' || action.type === 'type') && action.box) {
      if (zoom) camera.focus(t, move, action.box);
      t = cursor.moveToBox(t, move, action.box);
      if (action.type !== 'hover') t = cursor.click(t);
      if (action.type === 'type' && action.text) {
        const box = action.box;
        const field = scene.el('div', {
          parent: camera.world,
          style: {
            position: 'absolute',
            left: `${box.x + 2}px`,
            top: `${box.y + 2}px`,
            width: `${box.width - 4}px`,
            height: `${box.height - 4}px`,
            borderRadius: `${Math.round(box.height * 0.18)}px`,
            display: 'flex',
            alignItems: 'center',
            padding: `0 ${Math.round(box.height * 0.3) - 2}px`,
            boxSizing: 'border-box',
            font: `${Math.round(box.height * 0.42)}px/1 var(--font, system-ui, sans-serif)`,
            color: '#1a1b23',
            background: '#fff',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            ...options.inputStyle,
          },
        });
        scene.set(field, 0, {opacity: 0});
        scene.set(field, t + 120, {opacity: 1});
        t = scene.type(field, {at: t + 120, text: action.text, cps: options.typingCps ?? 13}) + 250;
        if (next) scene.set(field, t + 260, {opacity: 0});
      } else {
        t += 220;
      }
    } else if (action?.type === 'press') {
      scene.caption(`⏎ ${action.key ?? 'Enter'}`, {at: t, dur: 900, position: 'top'});
      t += 500;
    } else if (action?.type === 'scroll' && next) {
      scene.tween(next, {at: t, dur: 500, from: {y: 60}, to: {y: 0}, ease: 'out'});
    }

    if (next) {
      const fadeStart = t;
      t = scene.crossfade(images[i], next, t);
      const nextAction = manifest.plates[i + 1]?.action;
      const staysClose = action?.type === 'type' && nextAction?.box && action.box && Math.hypot(nextAction.box.x - action.box.x, nextAction.box.y - action.box.y) < manifest.viewport.width * 0.3;
      if (zoom && !staysClose) camera.overview(fadeStart, 650, nextAction?.box ?? firstBox);
    }
    scene.section(`step-${i + 1}`, label, sectionStart, t);
  });

  const endStart = t;
  t += options.endHold ?? 1300;
  if (zoom) camera.overview(endStart, 700, camera.mode === 'cover' ? firstBox : undefined);
  cursor.moveTo(endStart, 900, {x: manifest.viewport.width * 0.82, y: manifest.viewport.height * 1.05});
  if (options.loop !== false && images.length > 1) {
    t = scene.crossfade(images[images.length - 1], images[0]!, t, 400);
  }
  scene.section('outro', 'Outro', endStart, t);
  return {camera, cursor, images, end: t};
}

export function defineCssScene(options: {width: number; height: number; duration: number; sections?: Section[]; beats?: Beat[]}): SceneHandle {
  const seek = (t: number) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = t;
    }
  };
  const handle: SceneHandle = {contract: 1, width: options.width, height: options.height, duration: options.duration, sections: options.sections ?? [], beats: options.beats ?? [], seek, ready: document.fonts.ready};
  window.__scene = handle;
  autoplay(handle);
  return handle;
}

function autoplay(handle: SceneHandle): void {
  const params = new URLSearchParams(location.search);
  if (window.parent !== window || params.has('render') || params.has('static')) return;
  void handle.ready.then(() => {
    const started = performance.now();
    const frame = () => {
      const t = (performance.now() - started) % Math.max(handle.duration, 1);
      void handle.seek(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

export function createScene(options: SceneOptions): Scene {
  return new Scene(options);
}

export async function imageSize(src: string): Promise<{width: number; height: number}> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return {width: img.naturalWidth, height: img.naturalHeight};
}

export function fitBox(container: {width: number; height: number}, aspect: number): {width: number; height: number} {
  const width = Math.min(container.width, container.height * aspect);
  return {width, height: width / aspect};
}

export async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}
