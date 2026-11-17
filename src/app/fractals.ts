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
    id: 'multibrot3',
    name: 'Multibrot³',
    blurb: 'The cubic cousin of the Mandelbrot set — twin lobes, twice the symmetry.',
    home: { x: 0, y: 0, w: 3.2 },
    flipY: false,
    formulaTex: 'z³ + c',
  },
  {
    id: 'multibrot4',
    name: 'Multibrot⁴',
    blurb: 'z⁴ + c — three-fold symmetry, with Mandelbrot-like spirals and mini-copies everywhere you look.',
    home: { x: -0.05, y: 0, w: 3.9 },
    flipY: false,
    formulaTex: 'z⁴ + c',
  },
];

export const fractalById = (id: string) => FRACTALS.find((f) => f.id === id) ?? FRACTALS[0];

export interface JuliaC {
  x: HP;
  y: HP;
}

export const DEFAULT_JULIA: JuliaC = { x: fromNumber(-0.7746806106269039), y: fromNumber(-0.1374168856037867) };
