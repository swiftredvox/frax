import { addScaled, bitsFor, fromNumber, withPrecision } from '../core/hp';
import type { View } from '../engine/engine';

export function homeView(h: { x: number; y: number; w: number }): View {
  return { cx: fromNumber(h.x, 64), cy: fromNumber(h.y, 64), log2w: Math.log2(h.w) };
}

/**
 * Zoom by `dlog2` (negative = in) keeping the point at relative screen
 * offset (ax, ay) fixed. Offsets are in units of the view width; y is in
 * complex-plane orientation (up = +).
 */
export function zoomAt(v: View, ax: number, ay: number, dlog2: number): View {
  const k = 1 - Math.pow(2, dlog2);
  const nl = v.log2w + dlog2;
  const p = bitsFor(nl - 12);
  return {
    cx: addScaled(v.cx, ax * k, v.log2w, p),
    cy: addScaled(v.cy, ay * k, v.log2w, p),
    log2w: nl,
  };
}

/** Move the view centre by (dx, dy) in units of the view width. */
export function pan(v: View, dx: number, dy: number): View {
  const p = bitsFor(v.log2w - 12);
  return { cx: addScaled(v.cx, dx, v.log2w, p), cy: addScaled(v.cy, dy, v.log2w, p), log2w: v.log2w };
}

export function sameView(a: View, b: View) {
  return a.log2w === b.log2w && a.cx.m === b.cx.m && a.cx.p === b.cx.p && a.cy.m === b.cy.m && a.cy.p === b.cy.p;
}

export function trimView(v: View): View {
  const p = bitsFor(v.log2w - 12);
  return { cx: withPrecision(v.cx, p), cy: withPrecision(v.cy, p), log2w: v.log2w };
}

/** Human readable magnification, e.g. "3.2 × 10^42". */
export function magnification(log2w: number, homeLog2w: number): { mant: string; exp: number; plain: string } {
  const l10 = (homeLog2w - log2w) * Math.LOG10E * Math.LN2;
  const exp = Math.floor(l10);
  const mant = Math.pow(10, l10 - exp);
  if (l10 < 6) {
    const v = Math.pow(10, l10);
    return { mant: '', exp: 0, plain: v < 10 ? v.toFixed(2) + '×' : Math.round(v).toLocaleString() + '×' };
  }
  return { mant: mant.toFixed(2), exp, plain: `${mant.toFixed(2)}e${exp}` };
}
