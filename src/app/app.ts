import { fromNumber, type HP } from '../core/hp';
import { Engine, type ColorParams, type FractalSpec, type Layer, type LayerStats, type View } from '../engine/engine';
import { buildPalette, hexToRgb01, PALETTES, type Palette } from '../engine/palettes';
import type { Formula } from '../engine/orbitTypes';
import { homeView, pan, trimView, zoomAt } from './camera';
import { Explorer } from './explorer';
import { DEFAULT_JULIA, fractalById, type FractalInfo } from './fractals';
import { attachInput } from './input';
import { Journey } from './journey';
import { LoopRun } from './loop';
import { LOOPS, type LoopTarget } from './loops';

export interface Settings {
  formula: Formula;
  palette: string;
  density: number; // colour bands multiplier (higher = more bands)
  cycle: number; // palette cycling speed
  shade: number; // 0..1 relief lighting
  speed: number; // journey speed, octaves per second
  loop: string; // chosen loop id, or 'shuffle'
  quality: number; // render scale
  detail: number; // iteration multiplier
}

export const DEFAULT_SETTINGS: Settings = {
  formula: 'mandelbrot',
  palette: 'abyss',
  density: 0.35,
  cycle: 0,
  shade: 0.9,
  speed: 0.55,
  loop: 'shuffle',
  quality: 1,
  detail: 1,
};

type Listener = () => void;

/** Settings remembered between visits. Location and fractal type are not. */
const PREF_KEYS = ['palette', 'density', 'cycle', 'shade', 'speed', 'quality', 'loop'] as const;
const PREF_STORE = 'frax.prefs.v1';

function loadPrefs(): Partial<Settings> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_STORE) || '{}') as Record<string, unknown>;
    const out: Partial<Settings> = {};
    for (const k of PREF_KEYS) {
      const v = raw[k];
      const ok =
        k === 'palette'
          ? typeof v === 'string' && PALETTES.some((p) => p.id === v)
          : k === 'loop'
            ? typeof v === 'string' && (v === 'shuffle' || LOOPS.some((l) => l.id === v))
            : typeof v === 'number' && Number.isFinite(v);
      if (ok) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePrefs(s: Settings) {
  try {
    const out: Record<string, unknown> = {};
    for (const k of PREF_KEYS) out[k] = s[k];
    localStorage.setItem(PREF_STORE, JSON.stringify(out));
  } catch {
    /* storage unavailable — preferences just won't persist */
  }
}

export class FraxApp {
  readonly engine: Engine;
  settings: Settings;
  view: View;
  julia = { ...DEFAULT_JULIA };
  info: FractalInfo;
  journey: Journey | null = null;
  loop: LoopRun | null = null;
  private lastLoopId = '';
  readonly explorer: Explorer;
  palette: Palette;

  private zoomAnim: { ax: number; ay: number; remaining: number } | null = null;
  private inertia = { vx: 0, vy: 0 };
  private period = 24;
  private offset = 0;
  private period2 = 24;
  private offset2 = 0;
  private fade = 1;
  /** dark dip after a jump: < 0 holds dark until the new view has colour stats */
  private dip = 1;
  private jumpAt = 0;
  private colourReady = false;
  /** set when a setting changes so the new colours apply without delay */
  private colourSnap = false;
  private phase = 0;
  private lastT = performance.now();
  private listeners = new Set<Listener>();
  private viewListeners = new Set<Listener>();
  private hoverFn: ((ax: number, ay: number) => void) | null = null;
  fps = 60;
  private lastColor: ColorParams | null = null;
  posterBusy = false;
  /** true while applying a shared link, so its palette doesn't overwrite saved preferences */
  applyingLink = false;
  paused = false;
  private captureHook: ((c: HTMLCanvasElement) => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: Partial<Settings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...loadPrefs(), ...settings };
    this.engine = new Engine(canvas);
    this.info = fractalById(this.settings.formula);
    this.view = homeView(this.info.home);
    this.palette = PALETTES.find((p) => p.id === this.settings.palette) ?? PALETTES[0];
    this.engine.setPalette(buildPalette(this.palette));
    this.explorer = new Explorer(
      this.engine,
      () => this.spec,
      () => this.renderSize,
      (v) => this.maxIterFor(v),
    );
    this.explorer.quality = this.settings.quality;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);

    attachInput(canvas, {
      interact: () => {
        this.stopJourney();
        this.stopLoop();
      },
      zoom: (ax, ay, d, smooth) => this.zoomBy(ax, ay, d, smooth),
      pan: (dx, dy) => {
        this.inertia = { vx: 0, vy: 0 };
        this.view = pan(this.view, dx, this.info.flipY ? -dy : dy);
        this.emitView();
      },
      panEnd: (vx, vy) => (this.inertia = { vx, vy: this.info.flipY ? -vy : vy }),
      tap: () => {},
      hover: (ax, ay) => this.hoverFn?.(ax, this.info.flipY ? -ay : ay),
    });

    requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------ properties

  get spec(): FractalSpec {
    return { formula: this.settings.formula, julia: this.julia };
  }

  get renderSize() {
    return { w: this.canvas.width, h: this.canvas.height };
  }

  get homeLog2w() {
    return Math.log2(this.info.home.w);
  }

  get isJourney() {
    return this.journey !== null;
  }

  get isLoop() {
    return this.loop !== null;
  }

  /** Either autopilot is driving the camera. */
  get isPlaying() {
    return this.journey !== null || this.loop !== null;
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onView(fn: Listener) {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  }
  onHover(fn: (ax: number, ay: number) => void) {
    this.hoverFn = fn;
  }
  private emit() {
    for (const f of this.listeners) f();
  }
  private emitView() {
    for (const f of this.viewListeners) f();
  }

  iterBase(log2w: number) {
    const depth = Math.max(0, this.homeLog2w - log2w);
    return 220 + 55 * depth + 0.06 * depth * depth;
  }

  maxIterFor(v: View): number {
    const base = this.iterBase(v.log2w);
    return Math.round(Math.min(1 << 22, base * (this.explorer?.iterBoost ?? 1) * this.settings.detail));
  }

  // ------------------------------------------------------------ actions

  set<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    if (key === 'density') this.colourSnap = true;
    if (key === 'palette') {
      this.palette = PALETTES.find((p) => p.id === value) ?? PALETTES[0];
      this.engine.setPalette(buildPalette(this.palette));
    } else if (key === 'formula') {
      this.colourJump();
      this.info = fractalById(value as string);
      this.stopJourney(false);
      this.stopLoop(false);
      this.explorer.reset();
      this.engine.cancelOrbits();
      this.view = homeView(this.info.home);
      this.emitView();
    } else if (key === 'quality') {
      this.explorer.quality = value as number;
      this.explorer.invalidate();
    } else if (key === 'detail') {
      this.explorer.invalidate();
    } else if (key === 'speed') {
      this.journey?.setOptions({ speed: value as number });
      this.loop?.setOptions({ speed: value as number });
    }
    if (!this.applyingLink && (PREF_KEYS as readonly string[]).includes(key)) savePrefs(this.settings);
    this.emit();
  }

  setJulia(x: number | HP, y: number | HP) {
    this.julia = {
      x: typeof x === 'number' ? fromNumber(x) : x,
      y: typeof y === 'number' ? fromNumber(y) : y,
    };
    if (this.settings.formula === 'julia') {
      this.colourJump();
      this.stopJourney(false);
      this.explorer.reset();
      this.engine.cancelOrbits();
    }
    this.emit();
  }

  /** Fade through dark into the next view instead of showing it in the old colours. */
  private colourJump() {
    if (this.colourReady) {
      this.dip = -1;
      this.jumpAt = performance.now();
    }
  }

  setView(v: View) {
    this.colourJump();
    this.stopJourney();
    this.stopLoop();
    this.zoomAnim = null;
    this.inertia = { vx: 0, vy: 0 };
    this.view = trimView(v);
    this.emitView();
  }

  home() {
    this.setView(homeView(this.info.home));
  }

  zoomBy(ax: number, ay: number, dlog2: number, smooth = true) {
    const ay2 = this.info.flipY ? -ay : ay;
    // Don't let people zoom out into empty space far beyond the whole set.
    const maxOut = this.homeLog2w + 1.5 - this.view.log2w - (this.zoomAnim?.remaining ?? 0);
    dlog2 = Math.min(dlog2, Math.max(0, maxOut));
    if (dlog2 === 0 && !this.zoomAnim) return;
    if (smooth) {
      const rem = (this.zoomAnim?.remaining ?? 0) + dlog2;
      this.zoomAnim = { ax, ay: ay2, remaining: Math.max(-6, Math.min(6, rem)) };
    } else {
      this.zoomAnim = null;
      this.view = zoomAt(this.view, ax, ay2, dlog2);
      this.emitView();
    }
  }

  startJourney(seed?: number) {
    if (this.journey) return;
    this.stopLoop();
    const js = this.info.journeyStart;
    if (js && this.view.log2w >= this.homeLog2w - 0.5) this.view = homeView(js);
    this.zoomAnim = null;
    this.inertia = { vx: 0, vy: 0 };
    this.journey = new Journey(
      this.engine,
      this.view,
      this.spec,
      () => this.renderSize,
      {
        speed: this.settings.speed,
        quality: Math.max(1.25, this.settings.quality * 1.35),
        iterCap: (l) => this.iterBase(l) * 6 * this.settings.detail,
      },
      this.maxIterFor(this.view),
      seed,
      this.explorer.take(this.view),
    );
    this.emit();
  }

  stopJourney(keepLayers = true) {
    const j = this.journey;
    if (!j) return;
    this.journey = null;
    const done = j.allLayers.filter((l) => l.status === 'done');
    if (keepLayers) {
      j.dispose((l) => done.includes(l));
      this.explorer.inherit(done);
    } else {
      j.dispose();
    }
    this.emit();
  }

  /** Start a loop (Mandelbrot only). Returns the loop chosen. */
  startLoop(id?: string): LoopTarget {
    this.stopJourney();
    this.stopLoop(false);
    if (this.settings.formula !== 'mandelbrot') this.set('formula', 'mandelbrot');
    const choice = id ?? this.settings.loop;
    let target = LOOPS.find((l) => l.id === choice);
    if (!target) {
      const pool = LOOPS.filter((l) => l.id !== this.lastLoopId);
      target = pool[Math.floor(Math.random() * pool.length)];
    }
    this.lastLoopId = target.id;
    this.zoomAnim = null;
    this.inertia = { vx: 0, vy: 0 };
    const atHome = Math.abs(this.view.log2w - this.homeLog2w) < 0.05 && !(this.view.rot ?? 0);
    if (!atHome) this.colourJump();
    this.loop = new LoopRun(
      this.engine,
      target,
      this.spec,
      { x: this.info.home.x, y: this.info.home.y, log2w: this.homeLog2w },
      () => this.renderSize,
      { speed: this.settings.speed, quality: Math.max(1, this.settings.quality) },
      (l) => this.iterBase(l),
    );
    this.view = this.loop.viewAt(0);
    this.emitView();
    this.emit();
    return target;
  }

  stopLoop(keepLayers = true) {
    const l = this.loop;
    if (!l) return;
    this.loop = null;
    const done = l.allLayers.filter((x) => x.status === 'done');
    if (keepLayers) {
      l.dispose((x) => done.includes(x));
      this.explorer.inherit(done);
    } else l.dispose();
    this.emit();
  }

  toggleLoop(): LoopTarget | null {
    if (this.loop) {
      this.stopLoop();
      return null;
    }
    return this.startLoop();
  }

  toggleJourney() {
    if (this.journey) this.stopJourney();
    else this.startJourney();
  }

  /**
   * Render the current view as a poster whose long edge is `longEdge` pixels,
   * matching the screen's shape. Playback pauses while it renders.
   */
  async poster(longEdge: number, onProgress: (f: number) => void): Promise<HTMLCanvasElement> {
    if (this.posterBusy) throw new Error('A poster is already rendering');
    this.posterBusy = true;
    const wasPaused = this.paused;
    this.paused = true;
    try {
      const edge = Math.min(longEdge, this.engine.maxPosterSize);
      const { w, h } = this.renderSize;
      const W = w >= h ? edge : Math.round((edge * w) / h);
      const H = w >= h ? Math.round((edge * h) / w) : edge;
      // Use at least the detail currently on screen.
      let it = this.maxIterFor(this.view);
      const all = [...(this.loop?.allLayers ?? []), ...(this.journey?.allLayers ?? []), ...this.explorer.layers];
      for (const l of all) if (Math.abs(l.log2w - this.view.log2w) < 2) it = Math.max(it, l.maxIter);
      const color = { ...this.lastColor!, mix: 1, dip: 1 };
      return await this.engine.renderPoster(this.view, W, H, it, this.spec, color, this.info.flipY, w, onProgress);
    } finally {
      this.paused = wasPaused;
      this.posterBusy = false;
    }
  }

  /** Render the current frame and hand the canvas to `fn` (for screenshots / recording). */
  capture(fn: (c: HTMLCanvasElement) => void) {
    this.captureHook = fn;
  }

  // ------------------------------------------------------------ frame loop

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.explorer.invalidate();
    }
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    const dtMs = Math.min(100, now - this.lastT);
    this.lastT = now;
    const dt = dtMs / 1000;
    if (dtMs > 0) this.fps = this.fps * 0.92 + (1000 / dtMs) * 0.08;

    // Camera motion
    if (this.loop) {
      this.view = this.paused ? this.loop.viewAt(this.loop.u) : this.loop.update(dt);
      this.emitView();
    } else if (this.journey) {
      if (!this.paused) this.view = this.journey.update(dt);
      else this.view = this.journey.camera();
      this.emitView();
    } else {
      if (this.zoomAnim) {
        const a = this.zoomAnim;
        const step = a.remaining * (1 - Math.exp(-dt * 12));
        const s = Math.abs(a.remaining) < 0.002 ? a.remaining : step;
        this.view = zoomAt(this.view, a.ax, a.ay, s);
        a.remaining -= s;
        if (a.remaining === 0) this.zoomAnim = null;
        this.emitView();
      }
      if (Math.abs(this.inertia.vx) + Math.abs(this.inertia.vy) > 0.002) {
        this.view = pan(this.view, this.inertia.vx * dt, this.inertia.vy * dt);
        const k = Math.exp(-dt * 4.5);
        this.inertia.vx *= k;
        this.inertia.vy *= k;
        this.emitView();
      }
      this.explorer.update(this.view, now);
    }

    this.engine.frame(dtMs);

    // Colour mapping adapts smoothly to the iteration range on screen.
    this.updateColourRange(dt);
    this.phase = (this.phase + this.settings.cycle * dt) % 1;

    const color: ColorParams = {
      period: this.period,
      phase: this.phase,
      offset: this.offset,
      period2: this.period2,
      offset2: this.offset2,
      mix: this.fade < 1 ? this.fade * this.fade * (3 - 2 * this.fade) : 1,
      dip: this.dip >= 1 ? 1 : Math.max(0, this.dip) ** 2 * (3 - 2 * Math.max(0, this.dip)),
      shade: this.settings.shade,
      mapMode: 0,
      interior: hexToRgb01(this.palette.interior),
      background: hexToRgb01(this.palette.interior),
    };
    const layers: Layer[] = this.loop
      ? [...this.loop.layers, ...this.explorer.layers]
      : this.journey
        ? [...this.journey.layers, ...this.explorer.layers]
        : this.explorer.layers;
    this.lastColor = color;
    this.engine.composite(this.view, layers, color, this.info.flipY);

    if (this.captureHook) {
      const f = this.captureHook;
      this.captureHook = null;
      f(this.canvas);
    }
  };

  /**
   * Colour is a fixed function of iteration count, and a point in the plane
   * always has the same count — so every structure keeps its colour while
   * you zoom; only newly revealed detail brings new shades. The band width
   * slowly adapts to how much range is on screen, pivoting around the
   * median so nothing visibly shifts. Big jumps (going home, switching
   * fractal) crossfade over a second instead of strobing.
   */
  private updateColourRange(dt: number) {
    if (this.loop) {
      // Loops colour by the iteration range of the frame itself, so the copy at
      // the end is coloured exactly like the full set at the start.
      const sp = this.loop.statsPair;
      if (this.dip < 0) this.dip = 0;
      if (this.dip < 1) this.dip = Math.min(1, this.dip + dt / 0.6);
      this.fade = 1;
      if (sp) {
        const tp = (s: LayerStats) => Math.max(2, s.spread * 0.4, s.detail * 5) / this.settings.density;
        this.period = Math.exp(Math.log(tp(sp.a)) * (1 - sp.f) + Math.log(tp(sp.b)) * sp.f);
        this.offset = sp.a.medianN * (1 - sp.f) + sp.b.medianN * sp.f;
        this.colourReady = true;
      }
      return;
    }
    // After a jump, wait (briefly) for a render of the new view before choosing colours.
    const waiting = this.dip < 0 && performance.now() - this.jumpAt < 2500;
    const stats = this.visibleStats(waiting ? this.jumpAt : 0);
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / 1.1);
    if (this.dip < 0) {
      // Just jumped somewhere new: stay dark until that view has colour stats, then fade in.
      if (!stats) {
        if (!waiting) this.dip = 0;
        return;
      }
      const tp0 = Math.max(2, stats.spread * 0.4, stats.detail * 5) / this.settings.density;
      this.period = tp0;
      this.offset = stats.medianN;
      this.fade = 1;
      this.dip = 0;
      return;
    }
    if (this.dip < 1) this.dip = Math.min(1, this.dip + dt / 0.6);
    if (!stats) return;
    // Wide enough to span the frame's range, never so tight that bands alias per pixel.
    const tp = Math.max(2, stats.spread * 0.4, stats.detail * 5) / this.settings.density;
    const pivot = stats.medianN;
    const setPeriod = (p: number) => {
      // Keep the colour at the pivot unchanged while the bands widen or narrow.
      this.offset = pivot - ((pivot - this.offset) * p) / this.period;
      this.period = p;
    };
    if (!this.colourReady) {
      this.period = tp;
      this.offset = pivot;
      this.colourReady = true;
      return;
    }
    if (this.colourSnap) {
      setPeriod(tp);
      this.colourSnap = false;
      return;
    }
    if (Math.abs(Math.log(tp / this.period)) > 0.9) {
      if (this.fade >= 1) {
        this.startFade();
        this.period = tp;
        this.offset = pivot;
      }
      return;
    }
    // Gentle, rate-limited adaptation of the band width.
    const maxLog = 0.05 * dt;
    const dl = Math.max(-maxLog, Math.min(maxLog, Math.log(tp / this.period)));
    if (dl !== 0) setPeriod(this.period * Math.exp(dl));
  }

  private startFade() {
    this.period2 = this.period;
    this.offset2 = this.offset;
    this.fade = 0;
  }

  private visibleStats(since = 0): LayerStats | null {
    if (this.journey) return this.journey.currentStats;
    // Closest in scale wins; among equals, the newest (it has the best iteration
    // count). Frames where nothing escaped say nothing about colour range.
    let best: Layer | null = null;
    const dist = (l: Layer) => Math.abs(l.log2w - this.view.log2w);
    for (const l of this.explorer.layers) {
      if (l.status !== 'done' || !l.stats || l.finishedAt < since) continue;
      if (dist(l) > 3 || l.stats.interior > 0.98) continue;
      if (!best || dist(l) < dist(best) - 1e-9 || (Math.abs(dist(l) - dist(best)) < 1e-9 && l.finishedAt > best.finishedAt)) best = l;
    }
    return best?.stats ?? null;
  }

  /** Busy state for the UI: rendering progress of the current view. */
  get status(): { rendering: boolean; stalled: boolean; orbit: boolean } {
    const rendering = this.loop ? !!this.loop.pendingLayer : this.journey ? !!this.journey.pendingLayer : this.explorer.busy;
    return { rendering, stalled: !!(this.journey?.stalled || this.loop?.stalled), orbit: this.engine.orbitBusy };
  }
}
