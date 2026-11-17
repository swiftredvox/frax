export type Formula = 'mandelbrot' | 'julia' | 'burningship' | 'multibrot3' | 'tricorn';

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
}
