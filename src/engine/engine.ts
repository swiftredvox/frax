import type { HP } from '../core/hp';
import { bitsFor, diffScaled, pow2 } from '../core/hp';
import { Program, TexPool, type PooledTex } from './gl';
import { OrbitService, type OrbitResult } from './orbit';
import type { Formula } from './orbitTypes';
import { COMPOSITE_FS, FINALIZE_FS, ITERATE_FS, PENDING_FS, STATS_FS, VS } from './shaders';

export interface View {
  cx: HP;
  cy: HP;
  log2w: number; // log2 of the view width in the complex plane
}

export interface FractalSpec {
  formula: Formula;
  julia: { x: HP; y: HP };
}

export interface LayerStats {
  gw: number;
  gh: number;
  /** per cell: interior, escaped, meanN, maxN, minN, detail, unfinished, meanLogN */
  cells: Float32Array;
  interior: number;
  maxN: number;
  minN: number;
  /** robust spread of iteration counts across the frame */
  spread: number;
  medianN: number;
  /** fraction of escaped pixels needing more than half the iteration cap */
  hiFrac: number;
  /** median per-texel iteration gradient — how busy the image is */
  detail: number;
}

export interface ColorParams {
  period: number;
  phase: number;
  offset: number;
  /** previous mapping, crossfaded out while mix < 1 */
  period2: number;
  offset2: number;
  mix: number;
  shade: number;
  mapMode: 0 | 1;
  interior: [number, number, number];
  background: [number, number, number];
}

type LayerStatus = 'orbit' | 'running' | 'done' | 'failed' | 'disposed';

export class Layer {
  status: LayerStatus = 'orbit';
  ref: RefTex | null = null;
  s0: PooledTex[] = [];
  s1: PooledTex[] = [];
  fbo: WebGLFramebuffer[] = [];
  cur = 0;
  initDone = false;
  result: PooledTex | null = null;
  stats: LayerStats | null = null;
  stepsDone = 0;
  query: WebGLQuery | null = null;
  queryAt = 0;
  startedAt = performance.now();
  finishedAt = 0;
  orbitProgress = 0;
  onDone?: (l: Layer) => void;
  tag = '';

  constructor(
    readonly id: number,
    readonly view: View,
    readonly w: number,
    readonly h: number,
    readonly maxIter: number,
    readonly spec: FractalSpec,
    public priority: number,
  ) {}

  get cx() {
    return this.view.cx;
  }
  get cy() {
    return this.view.cy;
  }
  get log2w() {
    return this.view.log2w;
  }
  /** log2 of one texel's size in the complex plane */
  get log2px() {
    return this.view.log2w - Math.log2(this.w);
  }
  get displayTex(): WebGLTexture | null {
    if (this.result) return this.result.tex;
    if (this.status === 'running' && this.initDone) return this.s1[this.cur].tex;
    return null;
  }
}

interface RefTex {
  orbit: OrbitResult;
  tex: WebGLTexture;
  users: number;
  lastUsed: number;
}

const LAYER_FORMULA: Record<Formula, number> = { mandelbrot: 0, julia: 1, burningship: 2, multibrot3: 3, tricorn: 4 };

export class Engine {
  readonly gl: WebGL2RenderingContext;
  private pool: TexPool;
  private orbits = new OrbitService();
  private refs: RefTex[] = [];
  private layers: Layer[] = [];
  private nextId = 1;
  private pIter: Program;
  private pFinal: Program;
  private pPend: Program;
  private pStats: Program;
  private pComp: Program;
  private vao: WebGLVertexArrayObject;
  private pendFbo: WebGLFramebuffer;
  private pendRb: WebGLRenderbuffer;
  private statsFbo: WebGLFramebuffer;
  private statsTex: WebGLTexture[] = [];
  private finFbo: WebGLFramebuffer;
  private palTex: WebGLTexture;
  readonly PEND = 32;

  /** Work budget in pixel-iterations per frame, tuned from frame times. */
  budget = 3e7;
  private dtAvg = 16;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This GPU/browser cannot render to float textures (EXT_color_buffer_float).');
    }
    this.gl = gl;
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pool = new TexPool(gl);
    this.pIter = new Program(gl, VS, ITERATE_FS);
    this.pFinal = new Program(gl, VS, FINALIZE_FS);
    this.pPend = new Program(gl, VS, PENDING_FS);
    this.pStats = new Program(gl, VS, STATS_FS);
    this.pComp = new Program(gl, VS, COMPOSITE_FS);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.pendFbo = gl.createFramebuffer()!;
    this.pendRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pendRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, this.PEND, this.PEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pendFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.pendRb);

    this.statsFbo = gl.createFramebuffer()!;
    this.finFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.palTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setPalette(rgba: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rgba.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  get activeLayers() {
    return this.layers;
  }

  get orbitBusy() {
    return this.orbits.busy;
  }

  // ------------------------------------------------------------------ layers

  createLayer(view: View, w: number, h: number, maxIter: number, spec: FractalSpec, priority = 0): Layer {
    const L = new Layer(this.nextId++, view, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), maxIter, spec, priority);
    this.layers.push(L);
    const ref = this.findRef(L);
    if (ref) {
      this.attachRef(L, ref);
    } else {
      const p = bitsFor(L.log2px + 4);
      this.orbits
        .compute(view.cx, view.cy, p, maxIter, spec.formula, spec.julia, (f) => (L.orbitProgress = f))
        .then((orbit) => {
          const r = this.uploadRef(orbit);
          if (L.status === 'orbit') this.attachRef(L, r);
        })
        .catch(() => {
          if (L.status === 'orbit') L.status = 'failed';
        });
    }
    return L;
  }

  private findRef(L: Layer): RefTex | null {
    const need = bitsFor(L.log2px + 4);
    for (const r of this.refs) {
      const o = r.orbit;
      if (o.formula !== L.spec.formula) continue;
      if (o.formula === 'julia' && o.juliaKey !== juliaKey(L.spec)) continue;
      if (o.p < need) continue;
      const truncated = o.seg1 >= o.maxIter + 1 || o.len - o.rebase >= o.maxIter + 1;
      if (truncated && o.maxIter < L.maxIter) continue;
      const dx = diffScaled(o.cx, L.cx, L.log2w);
      const dy = diffScaled(o.cy, L.cy, L.log2w);
      if (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) continue;
      return r;
    }
    return null;
  }

  private uploadRef(orbit: OrbitResult): RefTex {
    const gl = this.gl;
    const W = 4096;
    const rows = Math.max(1, Math.ceil(orbit.len / W));
    const data = new Float32Array(W * rows * 2);
    data.set(orbit.z.subarray(0, orbit.len * 2));
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, W, rows, 0, gl.RG, gl.FLOAT, data);
    const r: RefTex = { orbit, tex, users: 0, lastUsed: performance.now() };
    this.refs.unshift(r);
    this.gcRefs();
    return r;
  }

  private gcRefs() {
    while (this.refs.length > 6) {
      const i = this.refs.map((r, i) => [r, i] as const).reverse().find(([r]) => r.users === 0)?.[1];
      if (i === undefined) break;
      this.gl.deleteTexture(this.refs[i].tex);
      this.refs.splice(i, 1);
    }
  }

  private attachRef(L: Layer, r: RefTex) {
    r.users++;
    r.lastUsed = performance.now();
    L.ref = r;
    const gl = this.gl;
    for (let k = 0; k < 2; k++) {
      L.s0[k] = this.pool.get(L.w, L.h, 'rgba32f');
      L.s1[k] = this.pool.get(L.w, L.h, 'rg32f');
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, L.s0[k].tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, L.s1[k].tex, 0);
      L.fbo[k] = fb;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    L.status = 'running';
  }

  dispose(L: Layer) {
    if (L.status === 'disposed') return;
    this.freeWork(L);
    this.pool.release(L.result);
    L.result = null;
    L.status = 'disposed';
    const i = this.layers.indexOf(L);
    if (i >= 0) this.layers.splice(i, 1);
  }

  private freeWork(L: Layer) {
    const gl = this.gl;
    for (const t of L.s0) this.pool.release(t);
    for (const t of L.s1) this.pool.release(t);
    for (const f of L.fbo) gl.deleteFramebuffer(f);
    if (L.query) gl.deleteQuery(L.query);
    L.query = null;
    L.s0 = [];
    L.s1 = [];
    L.fbo = [];
    if (L.ref) {
      L.ref.users--;
      L.ref = null;
    }
  }

  /** Cancel queued reference orbits (used when the view jumps elsewhere). */
  cancelOrbits() {
    this.orbits.cancelAll();
  }

  // -------------------------------------------------------------- scheduling

  /** Call once per animation frame with the frame's dt (ms). */
  frame(dt: number) {
    if (dt > 0 && dt < 500) this.dtAvg = this.dtAvg * 0.9 + dt * 0.1;
    this.gpuTargetMs = Math.min(28, Math.max(6, this.dtAvg * 0.55));
    this.pollTimers();
    if (!this.timerExt) this.tuneBudget(dt);
    this.pollQueries();
    const running = this.layers.filter((l) => l.status === 'running').sort((a, b) => b.priority - a.priority);
    if (!running.length) return;
    let budget = this.budget;
    let spent = 0;
    const gl = this.gl;
    let q: WebGLQuery | null = null;
    if (this.timerExt && this.timers.length < 6) {
      q = gl.createQuery()!;
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    }
    for (const L of running) {
      if (budget <= 0) break;
      const px = L.w * L.h;
      const steps = Math.max(1, Math.min(8192, Math.floor(budget / px)));
      this.iterate(L, steps);
      budget -= steps * px;
      spent += steps * px;
    }
    if (q) {
      gl.endQuery(this.timerExt!.TIME_ELAPSED_EXT);
      this.timers.push({ q, work: spent });
    }
  }

  /** GPU timer queries give the real cost per pixel-iteration; size the budget from it. */
  private pollTimers() {
    const ext = this.timerExt;
    if (!ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (this.timers.length) {
      const t = this.timers[0];
      if (!gl.getQueryParameter(t.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(t.q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(t.q);
      this.timers.shift();
      if (disjoint || t.work <= 0 || ns <= 0) continue;
      const cost = ns / 1e6 / t.work; // ms per pixel-iteration
      this.costEst = this.costEst ? this.costEst * 0.8 + cost * 0.2 : cost;
    }
    if (this.costEst > 0) {
      this.budget = Math.min(Math.max(this.gpuTargetMs / this.costEst, 2e5), 6e9);
    }
  }

  /** Milliseconds of GPU time per frame spent on fractal iteration. */
  gpuTargetMs = 9;
  private costEst = 0;
  private timers: { q: WebGLQuery; work: number }[] = [];
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;

  private tuneBudget(dt: number) {
    if (!(dt > 0) || dt > 500) return;
    const target = 16.7 * 1.25;
    const busy = this.layers.some((l) => l.status === 'running');
    if (!busy) return;
    if (this.dtAvg > target * 1.3) this.budget *= 0.9;
    else if (this.dtAvg < target) this.budget *= 1.05;
    this.budget = Math.min(Math.max(this.budget, 1e6), 4e9);
  }

  private iterate(L: Layer, steps: number) {
    const gl = this.gl;
    const ref = L.ref!;
    const e0 = Math.floor(L.log2w);
    const pix = pow2(L.log2px - e0);
    const rx = diffScaled(L.cx, ref.orbit.cx, e0);
    const ry = diffScaled(L.cy, ref.orbit.cy, e0);
    const src = L.cur;
    const dst = 1 - L.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo[dst]);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, L.w, L.h);
    const p = this.pIter.use();
    p.tex('uS0', 0, L.s0[src].tex)
      .tex('uS1', 1, L.s1[src].tex)
      .tex('uOrbit', 2, ref.tex)
      .i('uInit', L.initDone ? 0 : 1)
      .v2('uHalf', L.w / 2, L.h / 2)
      .f('uPix', pix)
      .v2('uRefOff', rx, ry)
      .f('uE0', e0)
      .i('uRefLen', ref.orbit.len)
      .i('uSeg1', ref.orbit.seg1)
      .i('uRebase', ref.orbit.rebase)
      .i('uMaxIter', L.maxIter)
      .i('uSteps', steps)
      .f('uBail2', 1e4)
      .i('uFormula', LAYER_FORMULA[L.spec.formula])
      .f('uLogPow', Math.log(L.spec.formula === 'multibrot3' ? 3 : 2));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    L.cur = dst;
    L.initDone = true;
    L.stepsDone += steps;

    // Completion check: async occlusion query over a coarse grid.
    if (!L.query && L.stepsDone >= 8) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pendFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, this.PEND, this.PEND);
      const q = gl.createQuery()!;
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q);
      this.pPend.use().tex('uS1', 0, L.s1[L.cur].tex).iv2('uSize', L.w, L.h).iv2('uGrid', this.PEND, this.PEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      L.query = q;
      L.queryAt = L.stepsDone;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private pollQueries() {
    const gl = this.gl;
    for (const L of this.layers) {
      if (L.status !== 'running' || !L.query) continue;
      if (!gl.getQueryParameter(L.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const any = gl.getQueryParameter(L.query, gl.QUERY_RESULT);
      gl.deleteQuery(L.query);
      L.query = null;
      if (!any) this.finish(L);
    }
  }

  private finish(L: Layer) {
    const gl = this.gl;
    const res = this.pool.get(L.w, L.h, 'r32f');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.finFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, L.w, L.h);
    this.pFinal.use().tex('uS1', 0, L.s1[L.cur].tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    L.result = res;
    this.freeWork(L);
    L.stats = this.computeStats(L);
    L.status = 'done';
    L.finishedAt = performance.now();
    L.onDone?.(L);
  }

  private computeStats(L: Layer): LayerStats {
    const gl = this.gl;
    const gw = 48;
    const gh = Math.max(4, Math.min(64, Math.round((gw * L.h) / L.w)));
    if (this.statsTex.length === 0 || (this.statsTex as unknown as { gh?: number }).gh !== gh) {
      for (const t of this.statsTex) gl.deleteTexture(t);
      this.statsTex = [0, 1].map(() => {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, gw, gh);
        return t;
      });
      (this.statsTex as unknown as { gh?: number }).gh = gh;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.statsTex[0], 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.statsTex[1], 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, gw, gh);
    this.pStats.use().tex('uL', 0, L.result!.tex).iv2('uSize', L.w, L.h).iv2('uGrid', gw, gh).f('uHi', L.maxIter * 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const a = new Float32Array(gw * gh * 4);
    const b = new Float32Array(gw * gh * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, a);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, b);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const n = gw * gh;
    const cells = new Float32Array(n * 8);
    let interior = 0;
    let hiSum = 0;
    let escSum = 0;
    let maxN = 0;
    let minN = Infinity;
    const means: number[] = [];
    const dets: number[] = [];
    for (let i = 0; i < n; i++) {
      cells.set(a.subarray(i * 4, i * 4 + 4), i * 8);
      cells.set(b.subarray(i * 4, i * 4 + 4), i * 8 + 4);
      interior += a[i * 4];
      hiSum += b[i * 4 + 2] * a[i * 4 + 1];
      escSum += a[i * 4 + 1];
      if (a[i * 4 + 1] > 0) {
        maxN = Math.max(maxN, a[i * 4 + 3]);
        minN = Math.min(minN, b[i * 4]);
        means.push(a[i * 4 + 2]);
        dets.push(b[i * 4 + 1]);
      }
    }
    means.sort((x, y) => x - y);
    const q = (f: number) => (means.length ? means[Math.min(means.length - 1, Math.floor(f * means.length))] : 0);
    return {
      gw,
      gh,
      cells,
      interior: interior / n,
      maxN,
      minN: Number.isFinite(minN) ? minN : 0,
      spread: Math.max(1, q(0.85) - q(0.1)),
      medianN: q(0.5),
      detail: dets.length ? dets.sort((x, y) => x - y)[Math.floor(dets.length * 0.6)] : 0,
      hiFrac: escSum > 0 ? hiSum / escSum : 0,
    };
  }

  // -------------------------------------------------------------- display

  composite(cam: View, layers: Layer[], color: ColorParams, flipY = false) {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const camPx = cam.log2w - Math.log2(W);
    const vis = layers
      .filter((l) => l.displayTex && l.status !== 'disposed')
      .filter((l) => l.log2px > camPx - 1.6) // skip layers far finer than a screen pixel
      .sort((a, b) => a.log2px - b.log2px)
      .slice(0, 4);
    const rects = new Float32Array(16);
    const sizes = new Float32Array(8);
    vis.forEach((l, i) => {
      const sx = diffScaled(l.cx, cam.cx, cam.log2w);
      const sy = diffScaled(l.cy, cam.cy, cam.log2w);
      const w = Math.pow(2, l.log2w - cam.log2w);
      rects.set([sx, sy, w, (w * l.h) / l.w], i * 4);
      sizes.set([l.w, l.h], i * 2);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const p = this.pComp.use();
    for (let i = 0; i < 4; i++) p.tex('uL' + i, i, vis[i]?.displayTex ?? null);
    p.tex('uPal', 4, this.palTex)
      .v4a('uRect', rects)
      .v2a('uSize', sizes)
      .i('uCount', vis.length)
      .v2('uRes', W, H)
      .f('uPeriod', color.period)
      .f('uPhase', color.phase)
      .f('uOffset', color.offset)
      .f('uPeriod2', color.period2)
      .f('uOffset2', color.offset2)
      .f('uMix', color.mix)
      .f('uShade', color.shade)
      .i('uMapMode', color.mapMode)
      .v3('uInterior', ...color.interior)
      .v3('uBg', ...color.background)
      .f('uFlipY', flipY ? -1 : 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function juliaKey(s: FractalSpec) {
  return `${s.julia.x.m}/${s.julia.x.p},${s.julia.y.m}/${s.julia.y.p}`;
}
