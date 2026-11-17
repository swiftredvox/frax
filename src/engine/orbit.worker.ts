/// <reference lib="webworker" />
/**
 * Computes high-precision reference orbits for perturbation rendering.
 * Z is stored as float32 pairs; precision lives in the deltas on the GPU.
 *
 * Mandelbrot-type sets need one orbit: the view centre, which starts at the
 * critical point z = 0. Julia sets get two: the orbit of the view centre,
 * followed by the critical orbit (starting at 0) that pixels rebase onto.
 */
import type { Formula, OrbitRequest, OrbitResponse } from './orbitTypes';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function orbit(
  id: number,
  x: bigint,
  y: bigint,
  cx: bigint,
  cy: bigint,
  p: number,
  maxIter: number,
  bail2: number,
  formula: Formula,
  power: number,
  progressFrom: number,
  progressSpan: number,
): Float32Array {
  const P = BigInt(p);
  const B = BigInt(Math.floor(bail2)) << P;
  const n0 = Math.min(maxIter + 1, 1 << 26);
  let out = new Float32Array(2 * Math.min(n0, 1 << 16));
  const sh = BigInt(p - 52);
  const inv = 2 ** -52;
  let n = 0;
  let lastPost = performance.now();

  for (; n < n0; n++) {
    if (2 * n + 1 >= out.length) {
      const g = new Float32Array(Math.min(out.length * 2, 2 * n0));
      g.set(out);
      out = g;
    }
    out[2 * n] = Number(x >> sh) * inv;
    out[2 * n + 1] = Number(y >> sh) * inv;

    const x2 = (x * x) >> P;
    const y2 = (y * y) >> P;
    if (x2 + y2 > B) {
      n++;
      break;
    }
    if (formula === 'burningship') {
      const ax = x < 0n ? -x : x;
      const ay = y < 0n ? -y : y;
      const xy = (ax * ay) >> (P - 1n);
      x = x2 - y2 + cx;
      y = xy + cy;
    } else if (power === 3) {
      const nx = ((x * (x2 - 3n * y2)) >> P) + cx;
      const ny = ((y * (3n * x2 - y2)) >> P) + cy;
      x = nx;
      y = ny;
    } else if (formula === 'tricorn') {
      const xy = (x * y) >> (P - 1n);
      x = x2 - y2 + cx;
      y = cy - xy;
    } else {
      const xy = (x * y) >> (P - 1n);
      x = x2 - y2 + cx;
      y = xy + cy;
    }
    if ((n & 4095) === 0 && performance.now() - lastPost > 250) {
      lastPost = performance.now();
      ctx.postMessage({ id, progress: progressFrom + (progressSpan * n) / n0 });
    }
  }
  return out.subarray(0, 2 * n);
}

function compute(req: OrbitRequest): OrbitResponse {
  const { id, cx, cy, p, maxIter, bail2, formula, power, juliaX, juliaY } = req;
  if (formula !== 'julia') {
    const z = orbit(id, 0n, 0n, cx, cy, p, maxIter, bail2, formula, power, 0, 1).slice();
    return { id, z, len: z.length / 2, seg1: z.length / 2, rebase: 0 };
  }
  const a = orbit(id, cx, cy, juliaX, juliaY, p, maxIter, bail2, formula, power, 0, 0.5);
  const b = orbit(id, 0n, 0n, juliaX, juliaY, p, maxIter, bail2, formula, power, 0.5, 0.5);
  const z = new Float32Array(a.length + b.length);
  z.set(a);
  z.set(b, a.length);
  return { id, z, len: z.length / 2, seg1: a.length / 2, rebase: a.length / 2 };
}

ctx.onmessage = (ev: MessageEvent<OrbitRequest>) => {
  const res = compute(ev.data);
  ctx.postMessage(res, [res.z.buffer]);
};
