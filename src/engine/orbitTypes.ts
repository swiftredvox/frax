export type Formula = 'mandelbrot' | 'julia' | 'burningship' | 'multibrot3' | 'multibrot4';

export interface OrbitRequest {
  id: number;
  cx: bigint;
  cy: bigint;
  p: number;
  maxIter: number;
  bail2: number;
  formula: Formula;
  power: number;
  juliaX: bigint;
  juliaY: bigint;
  /** log2 of the largest pixel offset from the reference the BLA table must cover */
  log2DcMax: number;
}

export interface BlaData {
  ab: Float32Array;
  r: Float32Array;
  segs: { start: number; len: number; base: number; levels: number; levOff: number[] }[];
  log2DcMax: number;
}

export interface OrbitResponse {
  id: number;
  z: Float32Array;
  /** total points stored */
  len: number;
  /** points in the first (view) segment */
  seg1: number;
  /** index of the critical orbit used for rebasing (0 when it is the view orbit) */
  rebase: number;
  bla: BlaData | null;
}
