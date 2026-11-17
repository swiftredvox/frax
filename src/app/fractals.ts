import { fromNumber, type HP } from '../core/hp';
import type { Formula } from '../engine/orbitTypes';

export interface FractalInfo {
  id: Formula;
  name: string;
  blurb: string;
  home: { x: number; y: number; w: number };
  flipY: boolean;
  /** suggested starting point for the autopilot when starting from home */
  formulaTex: string;
  /** where journeys begin when started from the overview (defaults to home) */
  journeyStart?: { x: number; y: number; w: number };
}

export const FRACTALS: FractalInfo[] = [
  {
    id: 'mandelbrot',
    name: 'Mandelbrot',
    blurb: 'The classic. Endless spirals, seahorses and tiny copies of itself.',
    home: { x: -0.65, y: 0, w: 3.4 },
    flipY: false,
    formulaTex: 'z² + c',
  },
  {
    id: 'julia',
    name: 'Julia',
    blurb: 'One fixed c, every starting z. Pick c by exploring the Mandelbrot set.',
    home: { x: 0, y: 0, w: 3.6 },
    flipY: false,
    formulaTex: 'z² + k',
  },
  {
    id: 'burningship',
    name: 'Burning Ship',
    blurb: 'Absolute values fold the plane — masts, rigging and flames.',
    home: { x: -0.45, y: -0.55, w: 3.6 },
    flipY: true,
    formulaTex: '(|x| + i|y|)² + c',
    // Most of the ship's edge is chaotic dust; the classic structure lives on the left antenna.
    journeyStart: { x: -1.7612, y: -0.0285, w: 0.09 },
  },
  {
    id: 'tricorn',
    name: 'Tricorn',
    blurb: 'The Mandelbar: z is mirrored every step, giving three-fold symmetry and flowing, wave-like filaments.',
    home: { x: -0.3, y: 0, w: 4.4 },
    flipY: false,
    formulaTex: 'z̄² + c',
  },
  {
    id: 'multibrot3',
    name: 'Multibrot³',
    blurb: 'The cubic cousin of the Mandelbrot set — twin lobes, twice the symmetry.',
    home: { x: 0, y: 0, w: 3.2 },
    flipY: false,
    formulaTex: 'z³ + c',
  },
];

export const fractalById = (id: string) => FRACTALS.find((f) => f.id === id) ?? FRACTALS[0];

export interface JuliaC {
  x: HP;
  y: HP;
}

export const DEFAULT_JULIA: JuliaC = { x: fromNumber(-0.7746806106269039), y: fromNumber(-0.1374168856037867) };
