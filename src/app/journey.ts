import { addScaled, bitsFor, diffScaled, type HP } from '../core/hp';
import { toScreen, toWorld } from './camera';
import { keyframeSize, Pacer } from './pace';
import type { Engine, FractalSpec, Layer, LayerStats, View } from '../engine/engine';

interface Keyframe {
  index: number;
  view: View;
  layer: Layer;
  /** offset of the next keyframe's centre, in units of this keyframe's width */
  next: [number, number] | null;
  /** 1 = the next keyframe is zoomed in 2×; 0 = same scale, a sideways glide */
  dz: number;
}

export interface JourneyOptions {
  speed: number; // octaves (2× zoom steps) per second
  quality: number; // supersampling factor for keyframes
  /** upper bound on iterations for a view of width 2^log2w */
  iterCap: (log2w: number) => number;
}

/**
 * The autopilot. Renders a chain of keyframes, each zoomed 2× further than
 * the last, ahead of the camera. The camera glides through them, scaling
 * between neighbouring keyframes, so playback stays smooth no matter how
 * deep or slow each render is. Each keyframe is analysed to choose where
 * the next one should go: towards dense boundary detail, away from flat
 * interior, with a little randomness so no two journeys are alike.
 */
export class Journey {
  private kfs: Keyframe[] = [];
  t = 0;
  private velocity: [number, number] = [0, 0];
  private target: { x: HP; y: HP } | null = null;
  private maxIter: number;
  private rng: () => number;
  stalled = false;
  private pacer = new Pacer();
  private lastDone = -1;
  readonly startLog2w: number;
  private aspect: number;

  constructor(
    private engine: Engine,
    start: View,
    private spec: FractalSpec,
    private size: () => { w: number; h: number },
    private opts: JourneyOptions,
    startIter: number,
    seed = Math.floor(Math.random() * 1e9),
    firstLayer?: Layer,
  ) {
    this.startLog2w = start.log2w;
    this.maxIter = Math.max(256, Math.round(startIter));
    this.rng = mulberry32(seed);
    const { w, h } = size();
    this.aspect = h / w;
    // Reuse the frame already on screen as the first keyframe when possible.
    if (firstLayer && firstLayer.status === 'done') {
      this.kfs.push({ index: 0, view: firstLayer.view, layer: firstLayer, next: null, dz: 1 });
    } else this.addKeyframe(start);
  }

  setOptions(o: Partial<JourneyOptions>) {
    Object.assign(this.opts, o);
  }

  get depthIndex() {
    return this.t;
  }

  private addKeyframe(view: View) {
    const { w, h } = this.size();
    const q = this.opts.quality;
    const index = this.kfs.length ? this.kfs[this.kfs.length - 1].index + 1 : 0;
    const [kw, kh] = keyframeSize(w, h, q);
    const layer = this.engine.createLayer(view, kw, kh, this.maxIter, this.spec, 20 - index * 0.01);
    this.kfs.push({ index, view, layer, next: null, dz: 1 });
  }

  private kf(i: number) {
    const k = this.kfs.find((k) => k.index === i);
    return k;
  }

  private lastDoneIndex() {
    let d = -1;
    for (const k of this.kfs) {
      if (k.layer.status === 'done') d = k.index;
      else break;
    }
    return d;
  }

  /** Advance by dt seconds, plan ahead, and return the camera view. */
  update(dt: number): View {
    const last = this.kfs[this.kfs.length - 1];
    if (last.layer.status === 'failed') {
      // Try again with the same view; a failure here is usually a cancelled orbit.
      this.engine.dispose(last.layer);
      this.kfs.pop();
      this.addKeyframe(last.view);
    }

    // Plan the next keyframe as soon as the newest one is finished.
    const done = this.lastDoneIndex();
    const tail = this.kfs[this.kfs.length - 1];
    if (tail.layer.status === 'done' && tail.index - this.t < 4) this.plan(tail);

    // Camera speed eases off when the renderer is behind, instead of stuttering.
    const ahead = done - this.t;
    if (done > this.lastDone) {
      this.pacer.produced(done - this.lastDone);
      this.lastDone = done;
    }
    this.stalled = ahead < 0.35;
    this.t = Math.min(this.t + this.pacer.step(this.opts.speed, ahead, dt) * dt, Math.max(0, done));

    // Drop keyframes far behind the camera.
    while (this.kfs.length > 2 && this.kfs[1].index < Math.floor(this.t)) {
      const old = this.kfs.shift()!;
      this.engine.dispose(old.layer);
    }
    return this.camera();
  }

  camera(): View {
    const i = Math.floor(this.t);
    const f = this.t - i;
    const a = this.kf(i) ?? this.kfs[0];
    const W = a.view.log2w;
    const log2w = W - f * a.dz;
    const p = bitsFor(log2w - 12);
    if (!a.next || f === 0) return { cx: a.view.cx, cy: a.view.cy, log2w, rot: a.view.rot };
    // Zoom segments: constant on-screen velocity, offset ∝ (1 − 2^−f).
    // Glide segments (no zoom): ease in and out.
    const g = a.dz ? 2 * (1 - Math.pow(2, -f)) : f * f * (3 - 2 * f);
    return {
      cx: addScaled(a.view.cx, toWorld(a.view, a.next[0] * g, a.next[1] * g)[0], W, p),
      cy: addScaled(a.view.cy, toWorld(a.view, a.next[0] * g, a.next[1] * g)[1], W, p),
      log2w,
      rot: a.view.rot,
    };
  }

  /** Layers the compositor should draw, coarse fallback included. */
  get layers(): Layer[] {
    const i = Math.floor(this.t);
    return this.kfs.filter((k) => k.index >= i - 1 && k.index <= i + 2).map((k) => k.layer);
  }

  get allLayers(): Layer[] {
    return this.kfs.map((k) => k.layer);
  }

  get currentStats(): LayerStats | null {
    const i = Math.floor(this.t);
    const k = this.kf(i + 1) ?? this.kf(i);
    return (k?.layer.stats ?? this.kf(i)?.layer.stats) || null;
  }

  get pendingLayer(): Layer | null {
    return this.kfs.find((k) => k.layer.status !== 'done')?.layer ?? null;
  }

  private plan(k: Keyframe) {
    const s = k.layer.stats!;
    const W = k.view.log2w;
    const asp = this.aspect;

    const cells = scoreCells(s, asp);

    // ---- lost in smooth space? glide sideways to the nearest detail instead of zooming ----
    let nearBd = 0;
    for (const c of cells) if (Math.hypot(c.x, c.y) < 0.18) nearBd = Math.max(nearBd, c.bd);
    if (nearBd < 0.8) {
      let pick: Cell | null = null;
      for (const c of cells) {
        const sc = c.bd - Math.hypot(c.x, c.y) * 0.5 - c.inter * 3;
        if (c.bd >= 1 && (!pick || sc > pick.bd - Math.hypot(pick.x, pick.y) * 0.5 - pick.inter * 3)) pick = c;
      }
      if (pick) {
        k.next = [clamp(pick.x, -0.45, 0.45), clamp(pick.y, -0.45 * asp, 0.45 * asp)];
        k.dz = 0;
        this.velocity = [0, 0];
        this.target = null;
        const p0 = bitsFor(W - 12);
        const [gx, gy] = toWorld(k.view, k.next[0], k.next[1]);
        this.addKeyframe({ cx: addScaled(k.view.cx, gx, W, p0), cy: addScaled(k.view.cy, gy, W, p0), log2w: W, rot: k.view.rot });
        return;
      }
    }

    // ---- choose / keep a target ----
    let best = cells[0];
    let keep = false;
    if (this.target) {
      const [rx, ry] = toScreen(k.view, diffScaled(this.target.x, k.view.cx, W), diffScaled(this.target.y, k.view.cy, W));
      if (Math.abs(rx) < 0.45 && Math.abs(ry) < 0.45 * asp) {
        const c = nearestCell(cells, rx, ry);
        if (c && c.score > best.score * 0.7 && c.score > 0) keep = true;
      }
    }
    if (!keep) {
      const top = cells.slice(0, 6).filter((c) => c.score > 0);
      if (top.length) {
        let sum = 0;
        for (const c of top) sum += c.score * c.score;
        let r = this.rng() * sum;
        best = top[0];
        for (const c of top) {
          r -= c.score * c.score;
          if (r <= 0) {
            best = c;
            break;
          }
        }
      }
      const jx = (this.rng() - 0.5) * best.cw * 0.3;
      const jy = (this.rng() - 0.5) * best.ch * 0.3;
      const p = bitsFor(W - 20);
      const [tx, ty] = toWorld(k.view, best.x + jx, best.y + jy);
      this.target = { x: addScaled(k.view.cx, tx, W, p), y: addScaled(k.view.cy, ty, W, p) };
    }

    // ---- steer towards it: proportional, rate-limited, inside the safe box ----
    const tgt = this.target!;
    const [rx, ry] = toScreen(k.view, diffScaled(tgt.x, k.view.cx, W), diffScaled(tgt.y, k.view.cy, W));
    const lim = 0.22;
    const want: [number, number] = [clamp(rx * 0.75, -lim, lim), clamp(ry * 0.75, -lim * asp, lim * asp)];
    const acc = 0.07;
    this.velocity = [
      this.velocity[0] + clamp(want[0] - this.velocity[0], -acc, acc),
      this.velocity[1] + clamp(want[1] - this.velocity[1], -acc, acc),
    ];
    this.velocity[0] = clamp(this.velocity[0], -lim, lim);
    this.velocity[1] = clamp(this.velocity[1], -lim * asp, lim * asp);
    k.next = [this.velocity[0], this.velocity[1]];

    // ---- iteration budget follows the detail ----
    const cap = this.opts.iterCap(W - 1);
    if (s.hiFrac > 0.01) this.maxIter = Math.ceil(this.maxIter * 1.3);
    else if (s.hiFrac > 0.003) this.maxIter = Math.ceil(this.maxIter * 1.12);
    this.maxIter = Math.round(Math.min(this.maxIter, cap, 1 << 22));

    const p = bitsFor(W - 1 - 12);
    this.addKeyframe({
      cx: addScaled(k.view.cx, toWorld(k.view, k.next[0], k.next[1])[0], W, p),
      cy: addScaled(k.view.cy, toWorld(k.view, k.next[0], k.next[1])[1], W, p),
      log2w: W - 1,
      rot: k.view.rot,
    });
  }

  dispose(keep: (l: Layer) => boolean = () => false) {
    for (const k of this.kfs) if (!keep(k.layer)) this.engine.dispose(k.layer);
    this.kfs = [];
  }
}

interface Cell {
  bd: number;
  inter: number;
  x: number;
  y: number;
  cw: number;
  ch: number;
  score: number;
}

function scoreCells(s: LayerStats, asp: number): Cell[] {
  const { gw, gh, cells } = s;
  const n = gw * gh;
  let minL = Infinity;
  let maxL = -Infinity;
  for (let i = 0; i < n; i++) {
    if (cells[i * 8 + 1] > 0) {
      minL = Math.min(minL, cells[i * 8 + 7]);
      maxL = Math.max(maxL, cells[i * 8 + 7]);
    }
  }
  const lr = Math.max(1e-6, maxL - minL);

  // Interior in the neighbourhood: heading next to a big black region means the
  // screen will soon be mostly black, so look a few cells around each candidate.
  const R = 5;
  const near = new Float32Array(n);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      let sum = 0;
      let cnt = 0;
      for (let y = Math.max(0, j - R); y <= Math.min(gh - 1, j + R); y++)
        for (let x = Math.max(0, i - R); x <= Math.min(gw - 1, i + R); x++) {
          sum += cells[(y * gw + x) * 8];
          cnt++;
        }
      near[j * gw + i] = sum / cnt;
    }

  const out: Cell[] = [];
  const cw = 1 / gw;
  const ch = asp / gh;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const o = (j * gw + i) * 8;
      const inter = cells[o];
      const esc = cells[o + 1];
      const x = (i + 0.5) / gw - 0.5;
      const y = ((j + 0.5) / gh - 0.5) * asp;
      let score = -10;
      // Boundary density: rises with edge detail, but per-pixel chaos (dust) scores low.
      const det = cells[o + 5];
      const bd = esc > 0.3 ? Math.min(6, Math.log2(1 + det)) - Math.max(0, Math.log2(det / 20)) * 3 : 0;
      if (esc > 0.5) {
        const deep = (cells[o + 7] - minL) / lr;
        const dist = Math.hypot(x, y);
        const nb = near[j * gw + i];
        score = bd * 0.6 + deep * 0.8 - inter * 2.5 - nb * 1.5 - dist * 0.5;
      }
      out.push({ bd, inter, x, y, cw, ch, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function nearestCell(cells: Cell[], x: number, y: number) {
  let best: Cell | null = null;
  let bd = Infinity;
  for (const c of cells) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
