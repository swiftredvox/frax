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
): Float64Array {
  const P = BigInt(p);
  const B = BigInt(Math.floor(bail2)) << P;
  const n0 = Math.min(maxIter + 1, 1 << 26);
  let out = new Float64Array(2 * Math.min(n0, 1 << 16));
  const sh = BigInt(p - 52);
  const inv = 2 ** -52;
  let n = 0;
  let lastPost = performance.now();

  for (; n < n0; n++) {
    if (2 * n + 1 >= out.length) {
      const g = new Float64Array(Math.min(out.length * 2, 2 * n0));
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
    } else if (power === 4) {
      // z^4 = (z^2)^2
      const a = x2 - y2;
      const b = (x * y) >> (P - 1n);
      const nx = ((a * a - b * b) >> P) + cx;
      const ny = ((a * b) >> (P - 1n)) + cy;
      x = nx;
      y = ny;
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

const MAX_LEVELS = 24;
/** Approximation tolerance: the dropped δ² term stays below float precision. */
const EPS = 2 ** -24;

interface BlaTable {
  ab: Float64Array; // A.x, A.y, B.x, B.y per entry
  r: Float64Array;
  levels: number;
  levOff: number[];
}

/**
 * Bilinear approximation table for z² + c (and Julia, where B = 0).
 * Level 0, entry i: one step from reference index i — A = 2Z_i, B = 1.
 * Level l, entry k: 2^l steps from index k·2^l, merged from two level l−1
 * entries. R is the largest |δ| for which skipping is exact to float precision.
 */
function buildBla(z: Float64Array, start: number, len: number, julia: boolean, dcMax: number): BlaTable | null {
  const last = len - 1;
  if (last < 4) return null;
  const counts: number[] = [];
  for (let l = 0; l < MAX_LEVELS; l++) {
    const c = last >> l;
    if (c < 1) break;
    counts.push(c);
  }
  const levOff: number[] = [];
  let total = 0;
  for (const c of counts) {
    levOff.push(total);
    total += c;
  }
  const ab = new Float64Array(total * 4);
  const r = new Float64Array(total);
  const Bre = julia ? 0 : 1;
  for (let i = 0; i < counts[0]; i++) {
    const zx = z[2 * (start + i)];
    const zy = z[2 * (start + i) + 1];
    ab[4 * i] = 2 * zx;
    ab[4 * i + 1] = 2 * zy;
    ab[4 * i + 2] = Bre;
    ab[4 * i + 3] = 0;
    r[i] = EPS * 2 * Math.hypot(zx, zy);
  }
  for (let l = 1; l < counts.length; l++) {
    const prev = levOff[l - 1];
    const cur = levOff[l];
    for (let k = 0; k < counts[l]; k++) {
      const x = prev + 2 * k;
      const y = x + 1;
      const o = cur + k;
      const axr = ab[4 * x], axi = ab[4 * x + 1], bxr = ab[4 * x + 2], bxi = ab[4 * x + 3];
      const ayr = ab[4 * y], ayi = ab[4 * y + 1], byr = ab[4 * y + 2], byi = ab[4 * y + 3];
      const ar = ayr * axr - ayi * axi;
      const ai = ayr * axi + ayi * axr;
      const br = ayr * bxr - ayi * bxi + byr;
      const bi = ayr * bxi + ayi * bxr + byi;
      const aMag = Math.hypot(axr, axi);
      let rr = Math.min(r[x], aMag > 0 ? Math.max(0, (r[y] - Math.hypot(bxr, bxi) * dcMax) / aMag) : 0);
      // Keep everything inside float32 range on the GPU.
      if (!(Math.abs(ar) < 1e30 && Math.abs(ai) < 1e30 && Math.abs(br) < 1e30 && Math.abs(bi) < 1e30)) rr = 0;
      ab[4 * o] = rr > 0 ? ar : 0;
      ab[4 * o + 1] = rr > 0 ? ai : 0;
      ab[4 * o + 2] = rr > 0 ? br : 0;
      ab[4 * o + 3] = rr > 0 ? bi : 0;
      r[o] = rr;
    }
  }
  return { ab, r, levels: counts.length, levOff };
}

function compute(req: OrbitRequest): OrbitResponse {
  const { id, cx, cy, p, maxIter, bail2, formula, power, juliaX, juliaY, log2DcMax } = req;
  let z64: Float64Array;
  let seg1: number;
  let rebase: number;
  if (formula !== 'julia') {
    z64 = orbit(id, 0n, 0n, cx, cy, p, maxIter, bail2, formula, power, 0, 0.9);
    seg1 = z64.length / 2;
    rebase = 0;
  } else {
    const a = orbit(id, cx, cy, juliaX, juliaY, p, maxIter, bail2, formula, power, 0, 0.45);
    const b = orbit(id, 0n, 0n, juliaX, juliaY, p, maxIter, bail2, formula, power, 0.45, 0.45);
    z64 = new Float64Array(a.length + b.length);
    z64.set(a);
    z64.set(b, a.length);
    seg1 = a.length / 2;
    rebase = seg1;
  }
  const len = z64.length / 2;
  const z = Float32Array.from(z64);

  // BLA only for the quadratic sets (Mandelbrot and Julia).
  let bla: OrbitResponse['bla'] = null;
  if (formula === 'mandelbrot' || formula === 'julia') {
    const dcMax = Math.pow(2, log2DcMax);
    const segs = formula === 'julia' ? [[0, seg1], [rebase, len - rebase]] : [[0, len]];
    const tables = segs.map(([s, l]) => buildBla(z64, s, l, formula === 'julia', dcMax));
    let total = 0;
    for (const t of tables) total += t ? t.r.length : 0;
    const ab = new Float32Array(Math.max(1, total) * 4);
    const r = new Float32Array(Math.max(1, total));
    const meta: { start: number; len: number; base: number; levels: number; levOff: number[] }[] = [];
    let base = 0;
    tables.forEach((t, i) => {
      const [s, l] = segs[i];
      if (t) {
        ab.set(t.ab, base * 4);
        r.set(t.r, base);
      }
      meta.push({ start: s, len: l, base, levels: t ? t.levels : 0, levOff: t ? t.levOff : [] });
      base += t ? t.r.length : 0;
    });
    bla = { ab, r, segs: meta, log2DcMax };
  }
  return { id, z, len, seg1, rebase, bla };
}

ctx.onmessage = (ev: MessageEvent<OrbitRequest>) => {
  const res = compute(ev.data);
  const transfer: Transferable[] = [res.z.buffer];
  if (res.bla) transfer.push(res.bla.ab.buffer, res.bla.r.buffer);
  ctx.postMessage(res, transfer);
};
