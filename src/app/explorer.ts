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
    if (L.stats && L.tag === 'full' && L.stats.hiFrac > 0.01 && this.iterBoost < 8) {
      // Detail is still being lost at the iteration cap: raise it and refine this view.
      this.iterBoost = Math.min(64, this.iterBoost * 2);
      if (this.lastCam && sameView(L.view, this.lastCam)) this.fullView = null;
    } else if (L.stats && L.tag === 'full' && L.stats.hiFrac < 0.0002) {
      this.iterBoost = Math.max(1, this.iterBoost * 0.85);
    }
    // Previews older than a newer full render are no longer useful.
    if (L.tag === 'full') {
      for (const p of this.done.filter((l) => l.tag === 'preview' && l.finishedAt < L.finishedAt)) this.drop(p);
    }
    while (this.done.length > 7) this.drop(this.done[0]);
  }

  private drop(L: Layer) {
    const i = this.done.indexOf(L);
    if (i >= 0) this.done.splice(i, 1);
    this.engine.dispose(L);
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
