import type { HP } from '../core/hp';
import { withPrecision } from '../core/hp';
import type { Formula, OrbitRequest, OrbitResponse } from './orbitTypes';

export interface OrbitResult {
  z: Float32Array;
  len: number;
  seg1: number;
  rebase: number;
  maxIter: number;
  p: number;
  cx: HP;
  cy: HP;
  formula: Formula;
  juliaKey: string;
}

interface Pending {
  req: OrbitRequest;
  resolve: (r: OrbitResult) => void;
  reject: (e: unknown) => void;
  cx: HP;
  cy: HP;
  juliaKey: string;
  onProgress?: (f: number) => void;
}

/** Runs reference-orbit computations on a worker, one at a time. */
export class OrbitService {
  private worker!: Worker;
  private queue: Pending[] = [];
  private active: Pending | null = null;
  private nextId = 1;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL('./orbit.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<OrbitResponse | { id: number; progress: number }>) => {
      const a = this.active;
      if (!a || ev.data.id !== a.req.id) return;
      if ('progress' in ev.data) {
        a.onProgress?.(ev.data.progress);
        return;
      }
      const d = ev.data;
      this.active = null;
      a.resolve({
        z: d.z,
        len: d.len,
        seg1: d.seg1,
        rebase: d.rebase,
        maxIter: a.req.maxIter,
        p: a.req.p,
        cx: a.cx,
        cy: a.cy,
        formula: a.req.formula,
        juliaKey: a.juliaKey,
      });
      this.pump();
    };
    this.worker.onerror = (e) => {
      const a = this.active;
      this.active = null;
      a?.reject(e);
      this.pump();
    };
  }

  get busy() {
    return this.active !== null || this.queue.length > 0;
  }

  compute(
    cx: HP,
    cy: HP,
    p: number,
    maxIter: number,
    formula: Formula,
    julia: { x: HP; y: HP },
    onProgress?: (f: number) => void,
  ): Promise<OrbitResult> {
    const x = withPrecision(cx, p);
    const y = withPrecision(cy, p);
    const req: OrbitRequest = {
      id: this.nextId++,
      cx: x.m,
      cy: y.m,
      p,
      maxIter,
      bail2: 1e4,
      formula,
      power: formula === 'multibrot3' ? 3 : 2,
      juliaX: withPrecision(julia.x, p).m,
      juliaY: withPrecision(julia.y, p).m,
    };
    const juliaKey = formula === 'julia' ? `${julia.x.m}/${julia.x.p},${julia.y.m}/${julia.y.p}` : '';
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject, cx: x, cy: y, juliaKey, onProgress });
      this.pump();
    });
  }

  /** Abandon everything queued or running (terminates a long computation). */
  cancelAll() {
    const err = new Error('cancelled');
    for (const q of this.queue) q.reject(err);
    this.queue = [];
    if (this.active) {
      this.active.reject(err);
      this.active = null;
      this.worker.terminate();
      this.spawn();
    }
  }

  private pump() {
    if (this.active || this.queue.length === 0) return;
    this.active = this.queue.shift()!;
    this.worker.postMessage(this.active.req);
  }
}
