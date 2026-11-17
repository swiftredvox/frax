export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error('Shader compile failed:\n' + log);
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program link failed:\n' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(
    private gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
  ) {
    this.prog = compile(gl, vs, fs);
  }
  use() {
    this.gl.useProgram(this.prog);
    return this;
  }
  loc(name: string) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }
  i(name: string, v: number) {
    this.gl.uniform1i(this.loc(name), v);
    return this;
  }
  f(name: string, v: number) {
    this.gl.uniform1f(this.loc(name), v);
    return this;
  }
  v2(name: string, x: number, y: number) {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }
  iv2(name: string, x: number, y: number) {
    this.gl.uniform2i(this.loc(name), x, y);
    return this;
  }
  v3(name: string, x: number, y: number, z: number) {
    this.gl.uniform3f(this.loc(name), x, y, z);
    return this;
  }
  ia(name: string, a: Int32Array) {
    this.gl.uniform1iv(this.loc(name), a);
    return this;
  }
  v4a(name: string, a: Float32Array) {
    this.gl.uniform4fv(this.loc(name), a);
    return this;
  }
  v2a(name: string, a: Float32Array) {
    this.gl.uniform2fv(this.loc(name), a);
    return this;
  }
  tex(name: string, unit: number, t: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

export type TexFormat = 'rgba32f' | 'rg32f' | 'r32f';

const FMT: Record<TexFormat, [number, number]> = {
  rgba32f: [WebGL2RenderingContext.RGBA32F, WebGL2RenderingContext.RGBA],
  rg32f: [WebGL2RenderingContext.RG32F, WebGL2RenderingContext.RG],
  r32f: [WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED],
};

export interface PooledTex {
  tex: WebGLTexture;
  w: number;
  h: number;
  fmt: TexFormat;
}

/** Recycles float textures so layer churn doesn't thrash GPU memory. */
export class TexPool {
  private free: PooledTex[] = [];
  constructor(private gl: WebGL2RenderingContext) {}

  get(w: number, h: number, fmt: TexFormat): PooledTex {
    const i = this.free.findIndex((t) => t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) return this.free.splice(i, 1)[0];
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const [ifmt] = FMT[fmt];
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, fmt };
  }

  release(t: PooledTex | null | undefined) {
    if (!t) return;
    this.free.push(t);
    // Keep the pool from hoarding memory.
    while (this.free.length > 8) this.gl.deleteTexture(this.free.shift()!.tex);
  }

  clear() {
    for (const t of this.free) this.gl.deleteTexture(t.tex);
    this.free = [];
  }
}
