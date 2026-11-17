import { fromNumber, type HP } from '../core/hp';
import { Engine, type ColorParams, type FractalSpec, type Layer, type LayerStats, type View } from '../engine/engine';
import { buildPalette, hexToRgb01, PALETTES, type Palette } from '../engine/palettes';
import type { Formula } from '../engine/orbitTypes';
import { homeView, pan, trimView, zoomAt } from './camera';
import { Explorer } from './explorer';
import { DEFAULT_JULIA, fractalById, type FractalInfo } from './fractals';
import { attachInput } from './input';
import { Journey } from './journey';

export interface Settings {
  formula: Formula;
  palette: string;
  density: number; // colour bands multiplier (higher = more bands)
  cycle: number; // palette cycling speed
  shade: number; // 0..1 relief lighting
  speed: number; // journey speed, octaves per second
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
  quality: 1,
  detail: 1,
};

type Listener = () => void;

export class FraxApp {
  readonly engine: Engine;
  settings: Settings;
  view: View;
  julia = { ...DEFAULT_JULIA };
  info: FractalInfo;
  journey: Journey | null = null;
  readonly explorer: Explorer;
  palette: Palette;

  private zoomAnim: { ax: number; ay: number; remaining: number } | null = null;
  private inertia = { vx: 0, vy: 0 };
  private period = 24;
  private offset = 0;
  private period2 = 24;
  private offset2 = 0;
  private fade = 1;
  private colourReady = false;
  /** set when a setting changes so the new colours apply without delay */
  private colourSnap = false;
  private phase = 0;
  private lastT = performance.now();
  private listeners = new Set<Listener>();
  private viewListeners = new Set<Listener>();
  private hoverFn: ((ax: number, ay: number) => void) | null = null;
  fps = 60;
  paused = false;
  private captureHook: ((c: HTMLCanvasElement) => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: Partial<Settings> = {},
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
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
      interact: () => this.stopJourney(),
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
      this.info = fractalById(value as string);
      this.stopJourney(false);
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
    }
    this.emit();
  }

  setJulia(x: number | HP, y: number | HP) {
    this.julia = {
      x: typeof x === 'number' ? fromNumber(x) : x,
      y: typeof y === 'number' ? fromNumber(y) : y,
    };
    if (this.settings.formula === 'julia') {
      this.stopJourney(false);
      this.explorer.reset();
      this.engine.cancelOrbits();
    }
    this.emit();
  }

  setView(v: View) {
    this.stopJourney();
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

  toggleJourney() {
    if (this.journey) this.stopJourney();
    else this.startJourney();
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
    if (this.journey) {
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
      shade: this.settings.shade,
      mapMode: 0,
      interior: hexToRgb01(this.palette.interior),
      background: hexToRgb01(this.palette.interior),
    };
    const layers: Layer[] = this.journey ? [...this.journey.layers, ...this.explorer.layers] : this.explorer.layers;
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
    const stats = this.visibleStats();
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / 1.1);
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

  private visibleStats(): LayerStats | null {
    if (this.journey) return this.journey.currentStats;
    let best: Layer | null = null;
    for (const l of this.explorer.layers) {
      if (l.status !== 'done' || !l.stats) continue;
      if (!best || Math.abs(l.log2w - this.view.log2w) < Math.abs(best.log2w - this.view.log2w)) best = l;
    }
    return best?.stats ?? null;
  }

  /** Busy state for the UI: rendering progress of the current view. */
  get status(): { rendering: boolean; stalled: boolean; orbit: boolean } {
    const rendering = this.journey ? !!this.journey.pendingLayer : this.explorer.busy;
    return { rendering, stalled: !!this.journey?.stalled, orbit: this.engine.orbitBusy };
  }
}
