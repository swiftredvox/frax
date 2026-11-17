/**
 * GLSL ES 3.00 sources.
 *
 * Deep zoom uses perturbation theory: a single high-precision reference
 * orbit Z_n is computed on the CPU and every pixel iterates only its
 * difference δ from it in float32. Two tricks extend that past the float
 * range and keep it glitch-free:
 *   - Scaled deltas: δ = d · 2^e, with d kept near 1 and e an unbounded
 *     exponent, so zooms far beyond 1e-38 still work. Once δ is large
 *     enough to fit a normal float, the pixel switches to plain floats.
 *   - Rebasing: whenever |Z + δ| < |δ| (or the reference runs out) the
 *     pixel restarts from the critical orbit (the orbit of z = 0) with
 *     δ := z. This removes the "glitches" classic perturbation suffers
 *     from. For Mandelbrot-type sets the view reference *is* the critical
 *     orbit; Julia sets carry a second, critical reference for rebasing.
 *
 * Pixel state is kept in float textures and advanced a bounded number of
 * iterations per frame, so deep renders never stall the browser.
 */

export const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const ITERATE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uS0;     // d.x, d.y, e, m
uniform sampler2D uS1;     // result, n
uniform sampler2D uOrbit;  // reference orbit, RG32F, 4096 wide
uniform bool uInit;
uniform vec2 uHalf;        // half resolution (px)
uniform float uPix;        // pixel size, in units of 2^e0
uniform vec2 uRefOff;      // (job centre − reference) in units of 2^e0
uniform float uE0;
uniform int uRefLen;       // total stored reference points
uniform int uSeg1;         // end of the first segment (view orbit)
uniform int uRebase;       // index where the critical orbit (Z = 0) starts
uniform int uMaxIter;
uniform int uSteps;
uniform float uBail2;
uniform int uFormula;      // 0 mandelbrot, 1 julia, 2 burning ship, 3 multibrot-3
uniform float uLogPow;

layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;

vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 Zat(int m){ return texelFetch(uOrbit, ivec2(m & 4095, m >> 12), 0).xy; }

// |c + d| − |c|, evaluated without cancellation.
float diffabs(float c, float d){
  if (c >= 0.0) return (c + d >= 0.0) ? d : -(2.0*c + d);
  return (c + d > 0.0) ? (2.0*c + d) : -d;
}

// One perturbation step in scaled form: δ = d·2^e, s = 2^e,
// dct = δc expressed in units of 2^e.
vec2 stepD(vec2 Z, vec2 d, float s, float es, vec2 dct){
  if (uFormula == 2) {
    float x = 2.0*Z.x*d.x - 2.0*Z.y*d.y + s*(d.x*d.x - d.y*d.y);
    float cs = Z.x*Z.y * exp2(-es);            // XY in units of 2^e (may be ±inf: fine)
    float dd = Z.x*d.y + Z.y*d.x + s*d.x*d.y;
    float y = 2.0*diffabs(cs, dd);
    return vec2(x, y) + dct;
  }
  if (uFormula == 3) {
    vec2 Z2 = cmul(Z, Z);
    vec2 d2 = cmul(d, d);
    return 3.0*cmul(Z2, d) + 3.0*s*cmul(Z, d2) + s*s*cmul(d2, d) + dct;
  }
  vec2 r = cmul(2.0*Z, d) + s*cmul(d, d);
  return (uFormula == 1) ? r : r + dct;
}

void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 dc = (gl_FragCoord.xy - uHalf) * uPix + uRefOff;   // units of 2^e0
  vec4 s0, s1;
  if (uInit) {
    bool plain = uE0 > -100.0;
    vec2 d0 = (uFormula == 1) ? dc : vec2(0.0);
    s0 = plain ? vec4(d0 * exp2(uE0), 0.0, 0.0) : vec4(d0, uE0, 0.0);
    s1 = vec4(-1.0, 0.0, 0.0, 0.0);
  } else {
    s0 = texelFetch(uS0, ip, 0);
    s1 = texelFetch(uS1, ip, 0);
  }
  if (s1.x != -1.0) { o0 = s0; o1 = s1; return; }

  vec2 d = s0.xy;
  float e = s0.z;
  int m = int(s0.w);
  int n = int(s1.y);
  float result = -1.0;
  vec2 dcPlain = dc * exp2(uE0);

  for (int i = 0; i < uSteps; i++) {
    if (n >= uMaxIter) { result = -2.0; break; }
    vec2 Z = Zat(m);
    if (e == 0.0) {
      // ---- plain float phase ----
      vec2 z = Z + d;
      float r2 = dot(z, z);
      if (r2 > uBail2) {
        result = max(0.0, float(n) + 1.0 - log(0.5*log(r2)) / uLogPow);
        break;
      }
      int segEnd = (m < uSeg1) ? uSeg1 : uRefLen;
      if (m >= segEnd - 1 || dot(z, z) < dot(d, d)) {
        d = z; m = uRebase; Z = vec2(0.0);
      }
      d = stepD(Z, d, 1.0, 0.0, dcPlain);
      m++; n++;
    } else {
      // ---- scaled phase: δ = d·2^e, far below float range ----
      int segEnd = (m < uSeg1) ? uSeg1 : uRefLen;
      if (m >= segEnd - 1) {
        d = Z + d * exp2(e); e = 0.0; m = uRebase;
        continue;
      }
      if (m != uRebase) {
        float ld = log2(max(abs(d.x), abs(d.y))) + e;
        float lz = log2(max(abs(Z.x), abs(Z.y)));
        if (lz < ld + 1.0) {
          vec2 zs = Z * exp2(-e) + d;
          if (dot(zs, zs) < dot(d, d)) { d = zs; m = uRebase; Z = vec2(0.0); }
        }
      }
      d = stepD(Z, d, exp2(e), e, dc * exp2(uE0 - e));
      m++; n++;
      float mx = max(abs(d.x), abs(d.y));
      if (mx > 0.0 && (mx > 256.0 || mx < 0.00390625)) {
        float k = floor(log2(mx));
        d *= exp2(-k);
        e += k;
      }
      if (e > -100.0) { d *= exp2(e); e = 0.0; }
    }
  }
  o0 = vec4(d, e, float(m));
  o1 = vec4(result, float(n), 0.0, 0.0);
}
`;

/** Copies the result channel into a compact R32F texture once a layer is done. */
export const FINALIZE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uS1;
out vec4 o;
void main(){ o = vec4(texelFetch(uS1, ivec2(gl_FragCoord.xy), 0).x, 0.0, 0.0, 1.0); }
`;

/**
 * Coarse "is anything still running?" pass. Each fragment covers a block of
 * the layer and survives only if a pixel in that block is unfinished; an
 * occlusion query on this pass tells us asynchronously when a layer is done.
 */
export const PENDING_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uS1;
uniform ivec2 uSize;
uniform ivec2 uGrid;
out vec4 o;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 a = c * uSize / uGrid;
  ivec2 b = (c + 1) * uSize / uGrid;
  for (int y = a.y; y < b.y; y++)
    for (int x = a.x; x < b.x; x++)
      if (texelFetch(uS1, ivec2(x, y), 0).x == -1.0) { o = vec4(1.0); return; }
  discard;
}
`;

/** Per-cell statistics used by the autopilot and the colour auto-range. */
export const STATS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uL;
uniform ivec2 uSize;
uniform ivec2 uGrid;
uniform float uHi;
layout(location=0) out vec4 o0;  // interiorFrac, escapedFrac, meanN, maxN
layout(location=1) out vec4 o1;  // minN, detail, hiFrac (escaped late), meanLogN
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 a = c * uSize / uGrid;
  ivec2 b = max(a + 1, (c + 1) * uSize / uGrid - 1);
  ivec2 st = max(ivec2(1), (b - a) / 24);
  float hi = 0.0, cnt = 0.0, inter = 0.0, esc = 0.0, unf = 0.0, sumN = 0.0, sumL = 0.0, mx = 0.0, mn = 1e30, det = 0.0, detN = 0.0;
  for (int y = a.y; y < b.y; y += st.y)
    for (int x = a.x; x < b.x; x += st.x) {
      float v = texelFetch(uL, ivec2(x, y), 0).x;
      cnt += 1.0;
      if (v == -1.0) { unf += 1.0; continue; }
      if (v < 0.0) { inter += 1.0; continue; }
      esc += 1.0; if (v > uHi) hi += 1.0; sumN += v; sumL += log(v + 1.0); mx = max(mx, v); mn = min(mn, v);
      float vx = texelFetch(uL, ivec2(x + 1, y), 0).x;
      float vy = texelFetch(uL, ivec2(x, y + 1), 0).x;
      if (vx >= 0.0 && vy >= 0.0) { det += abs(vx - v) + abs(vy - v); detN += 1.0; }
      else if (vx == -2.0 || vy == -2.0) { det += 4.0; detN += 1.0; }
    }
  o0 = vec4(inter / cnt, esc / cnt, esc > 0.0 ? sumN / esc : 0.0, mx);
  o1 = vec4(esc > 0.0 ? mn : 0.0, detN > 0.0 ? det / detN : 0.0, esc > 0.0 ? hi / esc : 0.0, esc > 0.0 ? sumL / esc : 0.0);
}
`;

/** Draws the visible frame from up to four rendered layers. */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform vec4 uRect[4];   // centre offset (x,y) and size (w,h), in camera-width units
uniform vec2 uSize[4];   // texel dimensions
uniform int uCount;
uniform vec2 uRes;
uniform sampler2D uPal;
uniform float uPeriod;
uniform float uPhase;
uniform float uOffset;
uniform float uShade;
uniform int uMapMode;
uniform vec3 uInterior;
uniform vec3 uBg;
uniform float uFlipY;
out vec4 frag;

float fetchL(int i, vec2 p, out bool ok){
  ok = false;
  vec4 r = uRect[i];
  vec2 uv = (p - r.xy) / r.zw + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  ivec2 t = ivec2(uv * uSize[i]);
  float v;
  if (i == 0) v = texelFetch(uL0, t, 0).x;
  else if (i == 1) v = texelFetch(uL1, t, 0).x;
  else if (i == 2) v = texelFetch(uL2, t, 0).x;
  else v = texelFetch(uL3, t, 0).x;
  if (v == -1.0) return 0.0;
  ok = true;
  return v;
}

float sampleV(vec2 p, out bool ok){
  for (int i = 0; i < 4; i++) {
    if (i >= uCount) break;
    float v = fetchL(i, p, ok);
    if (ok) return v;
  }
  ok = false;
  return 0.0;
}

float mapT(float v){
  return (uMapMode == 1) ? (log(v + 1.0) - log(uOffset + 1.0)) / uPeriod + uPhase : (v - uOffset) / uPeriod + uPhase;
}

vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }

vec3 colorAt(vec2 p, float px){
  bool ok;
  float v = sampleV(p, ok);
  if (!ok) return toLin(uBg);
  if (v < 0.0) return toLin(uInterior);
  vec3 c = toLin(texture(uPal, vec2(mapT(v), 0.5)).rgb);
  if (uShade > 0.0) {
    bool okx, oky;
    float vx = sampleV(p + vec2(px, 0.0), okx);
    float vy = sampleV(p + vec2(0.0, px), oky);
    if (okx && oky && vx >= 0.0 && vy >= 0.0) {
      vec2 g = vec2(mapT(vx) - mapT(v), mapT(vy) - mapT(v));
      g = clamp(g * 6.0, -8.0, 8.0);
      vec3 nrm = normalize(vec3(-g, 1.0));
      vec3 L = normalize(vec3(-0.55, 0.65, 0.75));
      float diff = max(dot(nrm, L), 0.0);
      float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
      c = c * mix(1.0, 0.25 + 1.0 * diff, uShade) + spec * 0.35 * uShade;
    } else if ((okx && vx < 0.0) || (oky && vy < 0.0)) {
      c *= mix(1.0, 0.55, uShade);
    }
  }
  return c;
}

void main(){
  float px = 1.0 / uRes.x;
  vec2 base = (gl_FragCoord.xy - 0.5 * uRes) * px;
  base.y *= uFlipY;
  vec3 acc = vec3(0.0);
  acc += colorAt(base + vec2(-0.125, -0.375) * px, px);
  acc += colorAt(base + vec2( 0.375, -0.125) * px, px);
  acc += colorAt(base + vec2( 0.125,  0.375) * px, px);
  acc += colorAt(base + vec2(-0.375,  0.125) * px, px);
  acc *= 0.25;
  frag = vec4(pow(acc, vec3(1.0 / 2.2)), 1.0);
}
`;
