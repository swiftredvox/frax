/**
 * Arbitrary-precision fixed-point numbers backed by BigInt.
 * A value is m · 2^-p. Precision grows as needed when zooming deeper.
 */
export interface HP {
  readonly m: bigint;
  readonly p: number;
}

export const ZERO: HP = { m: 0n, p: 64 };

/** 2^e as a double, safe for exponents outside the normal double range. */
export function pow2(e: number): number {
  if (e > 1000 || e < -1000) {
    const h = Math.trunc(e / 2);
    return Math.pow(2, h) * Math.pow(2, e - h);
  }
  return Math.pow(2, e);
}

function bitLengthApprox(x: bigint): number {
  // Upper bound accurate to 4 bits, good enough for normalising before Number().
  return x.toString(16).length * 4;
}

/** m · 2^e as a double. */
export function bigTimesPow2(m: bigint, e: number): number {
  if (m === 0n) return 0;
  const neg = m < 0n;
  let x = neg ? -m : m;
  const bl = bitLengthApprox(x);
  if (bl > 64) {
    const sh = bl - 64;
    x >>= BigInt(sh);
    e += sh;
  }
  const v = Number(x) * pow2(e);
  return neg ? -v : v;
}

export function withPrecision(a: HP, p: number): HP {
  if (p === a.p) return a;
  if (p > a.p) return { m: a.m << BigInt(p - a.p), p };
  return { m: a.m >> BigInt(a.p - p), p };
}

export function fromNumber(x: number, p = 64): HP {
  if (!Number.isFinite(x)) throw new Error('HP.fromNumber: non-finite');
  if (x === 0) return { m: 0n, p };
  const e = Math.floor(Math.log2(Math.abs(x)));
  const sh = 60 - e; // |x · 2^sh| ≈ 2^60
  const mm = BigInt(Math.round(x * pow2(sh)));
  let r: HP = { m: mm, p: sh };
  if (r.p < 0) r = withPrecision(r, 0);
  return withPrecision(r, Math.max(p, Math.min(r.p, p + 64)));
}

export function add(a: HP, b: HP): HP {
  const p = Math.max(a.p, b.p);
  return { m: withPrecision(a, p).m + withPrecision(b, p).m, p };
}

export function sub(a: HP, b: HP): HP {
  const p = Math.max(a.p, b.p);
  return { m: withPrecision(a, p).m - withPrecision(b, p).m, p };
}

/** a + f · 2^log2s, keeping at least `minP` bits. */
export function addScaled(a: HP, f: number, log2s: number, minP = a.p): HP {
  if (f === 0) return withPrecision(a, Math.max(a.p, minP));
  const fl = Math.floor(log2s);
  const t = fromNumber(f * Math.pow(2, log2s - fl), 64);
  // value = t.m · 2^-(t.p) · 2^fl
  let term: HP = { m: t.m, p: t.p - fl };
  if (term.p < 0) term = withPrecision(term, 0);
  const p = Math.max(a.p, minP);
  return withPrecision(add(a, term), p);
}

export function toNumber(a: HP): number {
  return bigTimesPow2(a.m, -a.p);
}

/** (a − b) / 2^log2s as a double — exact difference, then scaled. */
export function diffScaled(a: HP, b: HP, log2s: number): number {
  const d = sub(a, b);
  return bigTimesPow2(d.m, -d.p - log2s);
}

export function toDecimal(a: HP, digits: number): string {
  const neg = a.m < 0n;
  const abs = neg ? -a.m : a.m;
  const P = BigInt(a.p);
  const ip = abs >> P;
  const frac = abs - (ip << P);
  const scaled = (frac * 10n ** BigInt(digits) + (1n << (P - 1n))) >> P;
  let fs = scaled.toString().padStart(digits, '0');
  let ips = ip;
  if (fs.length > digits) {
    // rounding carried into the integer part
    ips += 1n;
    fs = fs.slice(1);
  }
  fs = fs.replace(/0+$/, '');
  return (neg ? '-' : '') + ips.toString() + (fs ? '.' + fs : '');
}

export function fromDecimal(s: string, p: number): HP {
  const str = s.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(str);
  if (!m) throw new Error('Bad number: ' + s);
  const neg = m[1] === '-';
  const ipart = m[2] || '0';
  const fpart = m[3] || '';
  const exp10 = parseInt(m[4] || '0', 10);
  let digits = BigInt(ipart + fpart);
  let scale = fpart.length - exp10; // value = digits · 10^-scale
  const P = BigInt(p);
  let v: bigint;
  if (scale >= 0) v = (digits << P) / 10n ** BigInt(scale);
  else v = (digits * 10n ** BigInt(-scale)) << P;
  return { m: neg ? -v : v, p };
}

/** Bits of precision a coordinate needs for a view of width 2^log2w. */
export function bitsFor(log2w: number): number {
  return Math.max(64, Math.ceil(-log2w) + 64);
}
