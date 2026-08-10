/**
 * Forward-mode automatic differentiation over three variables.
 *
 * A Dual carries a value together with its partial derivatives with respect
 * to x, y, and z. Every operation below propagates those partials by the
 * ordinary rules of calculus, so evaluating an expression once yields both
 * the value *and* the exact gradient — no finite-difference step to tune, no
 * accuracy cliff near a singularity.
 *
 * This is what lets Flux report div and curl of *any* typeable field, not
 * just the polynomial ones the Poly ring can differentiate symbolically
 * (see poly.ts / elem.ts). Pure, no rendering deps.
 */

export interface Dual {
  v: number;
  dx: number;
  dy: number;
  dz: number;
}

export const constant = (n: number): Dual => ({ v: n, dx: 0, dy: 0, dz: 0 });

/** The variable on `axis` (0 = x, 1 = y, 2 = z), seeded with d/dself = 1. */
export function variable(n: number, axis: 0 | 1 | 2): Dual {
  return {
    v: n,
    dx: axis === 0 ? 1 : 0,
    dy: axis === 1 ? 1 : 0,
    dz: axis === 2 ? 1 : 0,
  };
}

/**
 * Lift a single-argument function through the chain rule: `fv` is f(a.v) and
 * `dfv` is f'(a.v). Every unary elementary function below is one line of this.
 */
function chain(a: Dual, fv: number, dfv: number): Dual {
  return {
    v: fv,
    dx: dfv * a.dx,
    dy: dfv * a.dy,
    dz: dfv * a.dz,
  };
}

/** Lift a two-argument function: `dfa` = ∂f/∂a and `dfb` = ∂f/∂b at (a, b). */
function chain2(a: Dual, b: Dual, fv: number, dfa: number, dfb: number): Dual {
  return {
    v: fv,
    dx: dfa * a.dx + dfb * b.dx,
    dy: dfa * a.dy + dfb * b.dy,
    dz: dfa * a.dz + dfb * b.dz,
  };
}

// --- Arithmetic -------------------------------------------------------------

export const add = (a: Dual, b: Dual): Dual => ({
  v: a.v + b.v,
  dx: a.dx + b.dx,
  dy: a.dy + b.dy,
  dz: a.dz + b.dz,
});

export const sub = (a: Dual, b: Dual): Dual => ({
  v: a.v - b.v,
  dx: a.dx - b.dx,
  dy: a.dy - b.dy,
  dz: a.dz - b.dz,
});

export const neg = (a: Dual): Dual => ({
  v: -a.v,
  dx: -a.dx,
  dy: -a.dy,
  dz: -a.dz,
});

/** Product rule. */
export const mul = (a: Dual, b: Dual): Dual =>
  chain2(a, b, a.v * b.v, b.v, a.v);

/** Quotient rule. Division by zero yields ±Infinity / NaN, which callers
 *  detect as a singularity rather than silently smoothing over. */
export const div = (a: Dual, b: Dual): Dual =>
  chain2(a, b, a.v / b.v, 1 / b.v, -a.v / (b.v * b.v));

export const scale = (a: Dual, s: number): Dual => ({
  v: a.v * s,
  dx: a.dx * s,
  dy: a.dy * s,
  dz: a.dz * s,
});

/**
 * a^b. When the exponent is constant — by far the common case — this uses the
 * power rule, which keeps negative bases with whole exponents working
 * ((-2)³ = -8). A varying exponent goes through a^b = exp(b·ln a) and so
 * needs a positive base, exactly as the mathematics requires.
 */
export function pow(a: Dual, b: Dual): Dual {
  const bIsConst = b.dx === 0 && b.dy === 0 && b.dz === 0;
  if (bIsConst) {
    const fv = Math.pow(a.v, b.v);
    // d/da aⁿ = n·aⁿ⁻¹. At a = 0 with n < 1 this is infinite, which is true.
    const dfa = b.v * Math.pow(a.v, b.v - 1);
    return chain(a, fv, dfa);
  }
  const fv = Math.pow(a.v, b.v);
  return chain2(a, b, fv, (b.v * fv) / a.v, fv * Math.log(a.v));
}

// --- Elementary functions ---------------------------------------------------

export const sin = (a: Dual): Dual => chain(a, Math.sin(a.v), Math.cos(a.v));
export const cos = (a: Dual): Dual => chain(a, Math.cos(a.v), -Math.sin(a.v));
export const tan = (a: Dual): Dual => {
  const c = Math.cos(a.v);
  return chain(a, Math.tan(a.v), 1 / (c * c));
};

export const asin = (a: Dual): Dual =>
  chain(a, Math.asin(a.v), 1 / Math.sqrt(1 - a.v * a.v));
export const acos = (a: Dual): Dual =>
  chain(a, Math.acos(a.v), -1 / Math.sqrt(1 - a.v * a.v));
export const atan = (a: Dual): Dual =>
  chain(a, Math.atan(a.v), 1 / (1 + a.v * a.v));

/**
 * atan2(y, x) — the polar angle, and the reason `theta` works as a field
 * component. ∂/∂y = x/r² and ∂/∂x = −y/r², which is precisely why
 * (−y, x)/(x²+y²) is the gradient of theta away from the origin: the
 * curl-free field that still circulates. Undefined at the origin, as it
 * must be.
 */
export const atan2 = (y: Dual, x: Dual): Dual => {
  const r2 = x.v * x.v + y.v * y.v;
  return chain2(y, x, Math.atan2(y.v, x.v), x.v / r2, -y.v / r2);
};

export const exp = (a: Dual): Dual => {
  const e = Math.exp(a.v);
  return chain(a, e, e);
};
export const ln = (a: Dual): Dual => chain(a, Math.log(a.v), 1 / a.v);
export const log10 = (a: Dual): Dual =>
  chain(a, Math.log10(a.v), 1 / (a.v * Math.LN10));
export const log2 = (a: Dual): Dual =>
  chain(a, Math.log2(a.v), 1 / (a.v * Math.LN2));

export const sqrt = (a: Dual): Dual => {
  const s = Math.sqrt(a.v);
  return chain(a, s, 1 / (2 * s));
};
export const cbrt = (a: Dual): Dual => {
  const c = Math.cbrt(a.v);
  return chain(a, c, 1 / (3 * c * c));
};

export const sinh = (a: Dual): Dual => chain(a, Math.sinh(a.v), Math.cosh(a.v));
export const cosh = (a: Dual): Dual => chain(a, Math.cosh(a.v), Math.sinh(a.v));
export const tanh = (a: Dual): Dual => {
  const t = Math.tanh(a.v);
  return chain(a, t, 1 - t * t);
};

/** |a|. Not differentiable at 0; the derivative there is reported as 0. */
export const abs = (a: Dual): Dual =>
  chain(a, Math.abs(a.v), a.v > 0 ? 1 : a.v < 0 ? -1 : 0);

/** hypot(a, b) = √(a² + b²) — the polar radius, hence `r`. */
export const hypot = (a: Dual, b: Dual): Dual => {
  const h = Math.hypot(a.v, b.v);
  return chain2(a, b, h, a.v / h, b.v / h);
};

/** Selecting a branch also selects that branch's derivative. */
export const min = (a: Dual, b: Dual): Dual => (a.v <= b.v ? a : b);
export const max = (a: Dual, b: Dual): Dual => (a.v >= b.v ? a : b);

/** True when the value or any partial is non-finite — the singularity test. */
export function isFinite_(a: Dual): boolean {
  return (
    Number.isFinite(a.v) &&
    Number.isFinite(a.dx) &&
    Number.isFinite(a.dy) &&
    Number.isFinite(a.dz)
  );
}
