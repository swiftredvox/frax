import type { Engine, FractalSpec, Layer, View } from '../engine/engine';
import { sameView } from './camera';

/**
 * Interactive rendering: fast low-resolution previews while the view is
 * moving, a full-resolution render once it settles, and a cache of
 * finished layers so motion always has something sharp to show.
 */
export class Explorer {
  private done: Layer[] = [];
  private preview: Layer | null = null;
  private full: Layer | null = null;
  private lastCam: View | null = null;
  private lastChange = 0;
  private fullView: View | null = null;
  /** multiplier on the depth-based iteration estimate, learned from renders */
  iterBoost = 1;
  quality = 1;

  constructor(
    private engine: Engine,
    private spec: () => FractalSpec,
    private size: () => { w: number; h: number },
    private maxIterFor: (v: View) => number,
  ) {}

  get layers(): Layer[] {
    const out = [...this.done];
    if (this.full) out.push(this.full);
    if (this.preview) out.push(this.preview);
    return out;
  }

  get busy() {
    return !!(this.full || this.preview);
  }

  /** progress of the in-flight full render, 0..1, or -1 when idle */
  get fullLayer() {
    return this.full;
  }

  update(cam: View, now: number) {
    this.forgetBoostIfFar(cam.log2w);
    if (!this.lastCam || !sameView(cam, this.lastCam)) {
      this.lastChange = now;
      this.lastCam = cam;
    }
    const moving = now - this.lastChange < 140;

    if (this.full && this.full.status === 'done') {
      this.adopt(this.full);
      this.full = null;
    }
    if (this.preview && this.preview.status === 'done') {
      this.adopt(this.preview);
      this.preview = null;
    }
    for (const L of [this.full, this.preview]) {
      if (L && L.status === 'failed') {
        this.engine.dispose(L);
        if (L === this.full) this.full = null;
        else this.preview = null;
      }
    }

    // A full render that no longer matches the camera is wasted work.
    if (this.full && !sameView(this.full.view, cam)) {
      this.engine.dispose(this.full);
      this.full = null;
    }

    const { w, h } = this.size();
    if (moving) {
      if (!this.preview) {
        this.preview = this.engine.createLayer(cam, w * 0.3, h * 0.3, this.maxIterFor(cam), this.spec(), 10);
        this.preview.tag = 'preview';
      }
    } else if (!this.full && !(this.fullView && sameView(this.fullView, cam))) {
      this.fullView = cam;
      this.full = this.engine.createLayer(cam, w * this.quality, h * this.quality, this.maxIterFor(cam), this.spec(), 5);
      this.full.tag = 'full';
    }
  }

  private adopt(L: Layer) {
    this.done.push(L);
    if (L.stats && L.tag === 'full') this.refine(L);
    // Previews older than a newer full render are no longer useful.
    if (L.tag === 'full') {
      for (const p of this.done.filter((l) => l.tag === 'preview' && l.finishedAt < L.finishedAt)) this.drop(p);
      for (const p of this.done.filter((l) => l !== L && l.tag === 'full' && sameView(l.view, L.view))) this.drop(p);
    }
    while (this.done.length > 7) this.drop(this.done[0]);
  }

  private refineFor: { view: View; interior: number; tries: number } | null = null;

  /**
   * Black areas may be genuinely inside the set or just short of iterations.
   * Keep doubling the iteration cap while doing so still shrinks the black
   * area; stop once it no longer changes.
   */
  private refine(L: Layer) {
    const s = L.stats!;
    const same = this.refineFor && sameView(this.refineFor.view, L.view);
    const prev = same ? this.refineFor! : null;
    const helped = !prev || prev.interior - s.interior > 0.0015;
    const tries = prev ? prev.tries + 1 : 0;
    // A frame that is (almost) entirely black is never a finished picture: deep
    // views can need tens of thousands of iterations before anything escapes.
    const blank = s.interior > 0.9;
    const wantMore = (s.interior > 0.002 || s.hiFrac > 0.01) && (helped || blank) && tries < 9 && L.maxIter < 1 << 22;
    if (wantMore) {
      this.iterBoost = Math.min(256, this.iterBoost * 2);
      this.boostDepth = L.log2w;
      this.refineFor = { view: L.view, interior: s.interior, tries };
      if (this.lastCam && sameView(L.view, this.lastCam)) this.fullView = null;
    } else {
      this.refineFor = { view: L.view, interior: s.interior, tries: 99 };
    }
  }

  /** where the boost was learned; zooming far back out forgets it */
  private boostDepth = 0;

  forgetBoostIfFar(log2w: number) {
    if (this.iterBoost > 1 && log2w > this.boostDepth + 4) {
      this.iterBoost = 1;
      this.refineFor = null;
    }
  }

  private drop(L: Layer) {
    const i = this.done.indexOf(L);
    if (i >= 0) this.done.splice(i, 1);
    this.engine.dispose(L);
  }

  /** Hand over the finished full render of exactly this view, if there is one. */
  take(view: View): Layer | undefined {
    const i = this.done.findIndex((l) => l.tag === 'full' && sameView(l.view, view));
    if (i < 0) return undefined;
    return this.done.splice(i, 1)[0];
  }

  /** Take over finished layers produced elsewhere (e.g. by a journey). */
  inherit(layers: Layer[]) {
    for (const L of layers) if (L.status === 'done' && !this.done.includes(L)) this.done.push(L);
    this.done.sort((a, b) => a.finishedAt - b.finishedAt);
    while (this.done.length > 7) this.drop(this.done[0]);
  }

  reset() {
    for (const L of [...this.done]) this.drop(L);
    if (this.full) this.engine.dispose(this.full);
    if (this.preview) this.engine.dispose(this.preview);
    this.full = this.preview = null;
    this.fullView = null;
    this.lastCam = null;
    this.iterBoost = 1;
  }

  /** Force a fresh full-quality render of the current view. */
  invalidate() {
    if (this.full) this.engine.dispose(this.full);
    this.full = null;
    this.fullView = null;
  }
}
