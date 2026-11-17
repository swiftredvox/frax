/**
 * Cyclic gradient palettes, interpolated in OKLab for perceptually smooth
 * transitions. Every palette loops seamlessly (last stop blends to first).
 */
export interface Palette {
  id: string;
  name: string;
  stops: string[];
  interior: string;
}

export const PALETTES: Palette[] = [
  { id: 'aurora', name: 'Aurora', stops: ['#03101f', '#0b3a5c', '#1d8a8a', '#7fe0b0', '#f4f9e9', '#5fb4d9', '#13306b'], interior: '#02060d' },
  { id: 'ember', name: 'Ember', stops: ['#0a0204', '#3d0716', '#9b1b2a', '#f0592a', '#ffcf6b', '#fff6dc', '#c4542b', '#3a0b17'], interior: '#050102' },
  { id: 'abyss', name: 'Abyss', stops: ['#000208', '#06204a', '#1060a8', '#58b8f0', '#e8f8ff', '#3070c0', '#081a40'], interior: '#000105' },
  { id: 'nebula', name: 'Nebula', stops: ['#07020f', '#2a0b4d', '#7b1fa2', '#e0529c', '#ffb59a', '#fff1e0', '#8a5bd6', '#1b0d3d'], interior: '#030108' },
  { id: 'gilded', name: 'Gilded', stops: ['#050403', '#2b1d0e', '#7a5320', '#d9a441', '#fff1c1', '#a77a2e', '#3a2810'], interior: '#020201' },
  { id: 'lagoon', name: 'Lagoon', stops: ['#011417', '#03464d', '#0f8b84', '#6fd6b8', '#f2ffe9', '#f0c27b', '#2b6f6a'], interior: '#000a0b' },
  { id: 'prism', name: 'Prism', stops: ['#ff3b5c', '#ffb02e', '#e8ff5a', '#34e39a', '#2bb6ff', '#6a5cff', '#e04cff'], interior: '#06040c' },
  { id: 'frost', name: 'Frost', stops: ['#0b0f1a', '#2a3550', '#6a7ea8', '#c9d8f0', '#ffffff', '#9fb4d8', '#3a4a70'], interior: '#05070c' },
  { id: 'verdant', name: 'Verdant', stops: ['#020904', '#0d2e14', '#2f6b2a', '#9ccc4a', '#f6f7c8', '#5f9a3a', '#163d1c'], interior: '#010402' },
  { id: 'ink', name: 'Ink', stops: ['#000000', '#1a1a1a', '#5a5a5a', '#d8d8d8', '#ffffff', '#8a8a8a', '#2a2a2a'], interior: '#000000' },
  { id: 'classic', name: 'Classic', stops: ['#000764', '#206bcb', '#edffff', '#ffaa00', '#000200'], interior: '#000000' },
  { id: 'synth', name: 'Synthwave', stops: ['#0d0221', '#261447', '#ff3864', '#ff8f3f', '#fdf5a6', '#2de2e6', '#3b1d6e'], interior: '#06010f' },
];

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  r = toLin(r);
  g = toLin(g);
  b = toLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const c = (x: number) => Math.min(1, Math.max(0, toSrgb(x)));
  return [c(r), c(g), c(bb)];
}

/** 1024-texel looping gradient as RGBA8 (smoothstep-eased between stops). */
export function buildPalette(p: Palette, size = 1024): Uint8Array {
  const labs = p.stops.map((s) => rgbToOklab(hexToRgb(s)));
  const n = labs.length;
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = (i / size) * n;
    const k = Math.floor(t);
    let f = t - k;
    f = f * f * (3 - 2 * f);
    const a = labs[k % n];
    const b = labs[(k + 1) % n];
    const rgb = oklabToRgb([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
    out[i * 4] = Math.round(rgb[0] * 255);
    out[i * 4 + 1] = Math.round(rgb[1] * 255);
    out[i * 4 + 2] = Math.round(rgb[2] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function paletteCss(p: Palette): string {
  const s = [...p.stops, p.stops[0]];
  return `linear-gradient(90deg, ${s.map((c, i) => `${c} ${((i / (s.length - 1)) * 100).toFixed(1)}%`).join(', ')})`;
}

export function hexToRgb01(h: string): [number, number, number] {
  return hexToRgb(h);
}
