import { fromDecimal, toDecimal, bitsFor } from '../core/hp';
import type { FraxApp } from '../app/app';
import type { Destination } from '../app/destinations';
import { FRACTALS } from '../app/fractals';
import { PALETTES } from '../engine/palettes';
import type { Formula } from '../engine/orbitTypes';

/** Encode the current place as a URL hash: #m=…&x=…&y=…&z=…&p=… */
export function encodeState(app: FraxApp): string {
  const v = app.view;
  const digits = Math.max(6, Math.ceil(-v.log2w * 0.30103) + 8);
  const q = new URLSearchParams();
  q.set('m', app.settings.formula);
  q.set('x', toDecimal(v.cx, digits));
  q.set('y', toDecimal(v.cy, digits));
  q.set('z', (app.homeLog2w - v.log2w).toFixed(3));
  q.set('p', app.settings.palette);
  const rot = v.rot ?? 0;
  if (Math.abs(rot) > 1e-6) q.set('r', rot.toFixed(5));
  if (app.settings.formula === 'julia') {
    q.set('jx', toDecimal(app.julia.x, 16));
    q.set('jy', toDecimal(app.julia.y, 16));
  }
  return '#' + q.toString();
}

export interface DecodedState {
  formula?: Formula;
  palette?: string;
  view?: { x: string; y: string; depth: number; rot?: number };
  julia?: { x: string; y: string };
}

export function decodeState(hash: string): DecodedState {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out: DecodedState = {};
  const m = q.get('m');
  if (m && FRACTALS.some((f) => f.id === m)) out.formula = m as Formula;
  const p = q.get('p');
  if (p && PALETTES.some((x) => x.id === p)) out.palette = p;
  const x = q.get('x');
  const y = q.get('y');
  const z = parseFloat(q.get('z') ?? '');
  if (x && y && Number.isFinite(z) && /^[-+0-9.e]+$/i.test(x) && /^[-+0-9.e]+$/i.test(y)) {
    const r = parseFloat(q.get('r') ?? '0');
    out.view = { x, y, depth: Math.max(0, z), rot: Number.isFinite(r) ? r : 0 };
  }
  const jx = q.get('jx');
  const jy = q.get('jy');
  if (jx && jy && /^[-+0-9.e]+$/i.test(jx) && /^[-+0-9.e]+$/i.test(jy)) out.julia = { x: jx, y: jy };
  return out;
}

export function goToDestination(app: FraxApp, d: Destination) {
  applyState(app, { formula: d.formula, view: { x: d.x, y: d.y, depth: d.z }, julia: d.julia ? { x: d.julia[0], y: d.julia[1] } : undefined });
}

export function applyState(app: FraxApp, s: DecodedState) {
  app.applyingLink = true;
  try {
    applyInner(app, s);
  } finally {
    app.applyingLink = false;
  }
}

function applyInner(app: FraxApp, s: DecodedState) {
  if (s.palette) app.set('palette', s.palette);
  if (s.formula) app.set('formula', s.formula);
  if (s.julia) {
    try {
      app.setJulia(fromDecimal(s.julia.x, 80), fromDecimal(s.julia.y, 80));
    } catch {
      /* ignore malformed */
    }
  }
  if (s.view) {
    try {
      const log2w = app.homeLog2w - s.view.depth;
      const p = bitsFor(log2w - 12);
      app.setView({ cx: fromDecimal(s.view.x, p), cy: fromDecimal(s.view.y, p), log2w, rot: s.view.rot || undefined });
    } catch {
      /* ignore malformed */
    }
  }
}
