import { addScaled, bitsFor, fromDecimal, toNumber, type HP } from '../core/hp';
import type { Engine, FractalSpec, Layer, LayerStats, View } from '../engine/engine';
import { loopDepth, type LoopTarget } from './loops';
import { keyframeSize, Pacer } from './pace';

export interface LoopOptions {
  speed: number; // octaves per second
  quality: number;
}

/** Keyframes are rendered a little larger than the screen to cover the turning camera. */
const MARGIN = 1.15;
/** The first keyframes are kept between cycles so the restart is instant. */
const KEEP = 3;

/**
 * Loop mode. The camera follows an exact spiral from the full Mandelbrot set
 * into a mini copy of it. The copy is the full set shrunk by s (a complex
 * number: size and rotation), so the path is the continuous similarity
 *   view(t) = c* + s^t · (home − c*),   width · |s|^t,   rotation t·arg(s)
 * whose fixed point c* = c0 / (1 − s) sits beside the copy's nucleus c0.
 * At t = 1 the view frames the copy exactly as t = 0 frames the full set,
 * and the loop starts again.
 */
export class LoopRun {
  readonly depth: number; // octaves from start to the copy
  private theta: number;
  private cStar: { x: HP; y: HP };
  private delta: [number, number]; // home − c*, plane units
  private positions: number[]; // keyframe positions in octaves
  private kfs = new Map<number, Layer>();
  private ref: object | null = null;
  private refReady = false;
  private disposed = false;
  u = 0;
  cycle = 0;
  stalled = false;
  private pacer = new Pacer();
  private lastAvail = 0;

  constructor(
    private engine: Engine,
    readonly target: LoopTarget,
    private spec: FractalSpec,
    private home: { x: number; y: number; log2w: number },
    private size: () => { w: number; h: number },
    private opts: LoopOptions,
    private iterBase: (log2w: number) => number,
  ) {
    this.depth = loopDepth(target);
    this.theta = Math.atan2(target.si, target.sr);
    const P = bitsFor(home.log2w - this.depth - 24);
    const c0x = fromDecimal(target.x, P);
    const c0y = fromDecimal(target.y, P);
    // c* = c0 + c0·s/(1 − s); the correction is tiny, so doubles suffice for it.
    const [sr, si] = [target.sr, target.si];
    const dr = 1 - sr;
    const dm = dr * dr + si * si;
    // s/(1 − s) = s · conj(1 − s) / |1 − s|²
    const kr = (sr * dr - si * si) / dm;
    const ki = (sr * si + si * dr) / dm;
    const ax = toNumber(c0x);
    const ay = toNumber(c0y);
    this.cStar = {
      x: addScaled(c0x, ax * kr - ay * ki, 0, P),
      y: addScaled(c0y, ax * ki + ay * kr, 0, P),
    };
    this.delta = [home.x - toNumber(this.cStar.x), home.y - toNumber(this.cStar.y)];

    const n = Math.floor(this.depth);
    this.positions = [];
    for (let k = 0; k <= n; k++) if (this.depth - k > 0.35 || k === 0) this.positions.push(k);
    this.positions.push(this.depth);

    // One reference orbit at the spiral's centre serves every frame.
    const endPx = this.viewAt(this.depth).log2w - Math.log2(this.size().w * MARGIN);
    this.engine
      .prepareRef(
        { cx: this.cStar.x, cy: this.cStar.y, log2w: home.log2w - this.depth },
        this.iterFor(this.depth) + 16,
        spec,
        home.log2w + Math.log2(MARGIN) + 0.6,
        endPx,
      )
      .then((r) => {
        if (this.disposed) this.engine.releaseRef(r);
        else {
          this.ref = r;
          this.refReady = true;
        }
      })
      .catch(() => {});
  }

  setOptions(o: Partial<LoopOptions>) {
    Object.assign(this.opts, o);
  }

  /** Iterations needed at depth u: grows like period^(u / depth) toward the copy. */
  private iterFor(u: number) {
    const a = u / this.depth;
    const want = 260 * Math.pow(this.target.period, a) * (1 + 0.5 * a);
    return Math.round(Math.min(1 << 22, Math.max(this.iterBase(this.home.log2w - u) * 1.2, want)));
  }

  viewAt(u: number): View {
    const a = u / this.depth;
    const ang = a * this.theta;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const [dx, dy] = this.delta;
    const log2w = this.home.log2w - u;
    const p = bitsFor(log2w - 16);
    return {
      cx: addScaled(this.cStar.x, c * dx - s * dy, -u, p),
      cy: addScaled(this.cStar.y, s * dx + c * dy, -u, p),
      log2w,
      rot: ang,
    };
  }

  private ensure(i: number) {
    if (i < 0 || i >= this.positions.length || this.kfs.has(i)) return;
    const u = this.positions[i];
    const v = this.viewAt(u);
    const { w, h } = this.size();
    const q = this.opts.quality;
    const view: View = { ...v, log2w: v.log2w + Math.log2(MARGIN) };
    const [kw, kh] = keyframeSize(w * MARGIN, h * MARGIN, q);
    const L = this.engine.createLayer(view, kw, kh, this.iterFor(u), this.spec, 20 - i * 0.01);
    L.tag = 'loop';
    this.kfs.set(i, L);
  }

  private index(u: number) {
    let i = 0;
    while (i + 1 < this.positions.length && this.positions[i + 1] <= u) i++;
    return i;
  }

  update(dt: number): View {
    if (!this.refReady) {
      this.stalled = true;
      return this.viewAt(this.u);
    }
    const i = this.index(this.u);
    // Render the next few keyframes ahead; wrap around to the start near the end.
    for (let k = 0; k < 4; k++) {
      const j = i + k;
      if (j < this.positions.length) this.ensure(j);
      else this.ensure(j - this.positions.length + 1);
    }
    for (let k = 0; k < KEEP; k++) this.ensure(k);
    for (const [j, L] of this.kfs) {
      if (L.status === 'failed') {
        this.engine.dispose(L);
        this.kfs.delete(j);
      }
    }

    // How far ahead is everything rendered?
    let avail = this.u;
    for (let j = i + 1; j < this.positions.length; j++) {
      if (this.kfs.get(j)?.status === 'done') avail = this.positions[j];
      else break;
    }
    // Past the end the loop continues from the start, so count the (cached)
    // opening keyframes too — otherwise the camera would creep towards the
    // seam forever instead of gliding through it.
    if (avail >= this.depth) {
      for (let j = 1; j < KEEP && j < this.positions.length; j++) {
        if (this.kfs.get(j)?.status === 'done') avail = this.depth + this.positions[j];
        else break;
      }
    }
    if (this.kfs.get(i)?.status !== 'done') avail = this.u;
    const ahead = avail - this.u;
    if (avail > this.lastAvail) this.pacer.produced(avail - this.lastAvail);
    this.lastAvail = avail;
    this.stalled = ahead < 0.35;
    this.u = Math.min(this.u + this.pacer.step(this.opts.speed, ahead, dt) * dt, avail);

    if (this.u >= this.depth) {
      // Arrived inside the copy: it is the start again.
      this.u -= this.depth;
      this.lastAvail = Math.max(0, this.lastAvail - this.depth);
      this.cycle++;
    }

    // Free keyframes well behind the camera (keeping the first few for the next cycle).
    const now = this.index(this.u);
    for (const [j, L] of this.kfs) {
      if (j >= KEEP && (j < now - 1 || (now < KEEP && j > now + 4))) {
        this.engine.dispose(L);
        this.kfs.delete(j);
      }
    }
    return this.viewAt(this.u);
  }

  get layers(): Layer[] {
    const i = this.index(this.u);
    const out: Layer[] = [];
    for (const j of [i + 1, i, i + 2, i - 1]) {
      const L = this.kfs.get(j);
      if (L) out.push(L);
    }
    return out;
  }

  get allLayers(): Layer[] {
    return [...this.kfs.values()];
  }

  /** Colour range interpolated between the keyframes either side of the camera. */
  get statsPair(): { a: LayerStats; b: LayerStats; f: number } | null {
    const i = this.index(this.u);
    const a = this.kfs.get(i)?.stats;
    if (!a) return null;
    const b = this.kfs.get(i + 1)?.stats ?? a;
    const u0 = this.positions[i];
    const u1 = this.positions[i + 1] ?? u0 + 1;
    return { a, b, f: Math.min(1, Math.max(0, (this.u - u0) / Math.max(1e-6, u1 - u0))) };
  }

  get pendingLayer(): Layer | null {
    for (const L of this.kfs.values()) if (L.status !== 'done') return L;
    return null;
  }

  dispose(keep: (l: Layer) => boolean = () => false) {
    this.disposed = true;
    for (const L of this.kfs.values()) if (!keep(L)) this.engine.dispose(L);
    this.kfs.clear();
    if (this.ref) this.engine.releaseRef(this.ref);
    this.ref = null;
  }
}

