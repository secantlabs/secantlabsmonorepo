/**
 * Vector fields in the plane, and the things you measure with them.
 *
 * A field is a pair of elem.ts expressions. Its divergence and curl come out
 * two ways, and Flux uses both:
 *
 *   - **numerically**, from one dual-number pass per component (dual.ts), so
 *     any typeable field works and the partials are exact to floating point;
 *   - **symbolically**, when the components happen to be polynomial, by
 *     routing through the Poly ring — which is what lets Flux print
 *     "div F = 2x + 3y" exactly, and makes the identities (curl of a gradient
 *     is 0, and in 3D divergence of a curl is 0) hold as algebra rather than
 *     as floating-point near-misses.
 *
 * The line integrals here are the boundary side of the Theorem Bar. The
 * interior side lives in quad.ts and never calls into this file's integrators
 * — see the note at the top of quad.ts for why that separation is load-bearing.
 *
 * Pure, no rendering deps.
 */

import { type Dual } from "./dual";
import {
  ElemError,
  evalDual,
  isConstantIn,
  toPoly,
  type ElemFn,
  type Node,
  type Scope,
} from "./elem";
import * as P from "./poly";
import { type Poly } from "./poly";
import {
  adaptiveQuad,
  piecewiseQuad,
  type Pt,
  type Quad,
} from "./quad";

/** A planar vector field: two scalar expressions in x and y. */
export interface Field2 {
  x: Node;
  y: Node;
}

const EMPTY_SCOPE: Scope = new Map();

// ---------------------------------------------------------------------------
// Pointwise evaluation
// ---------------------------------------------------------------------------

/** Both components as duals — one pass gives every partial we need. */
export function fieldDuals(
  F: Field2,
  x: number,
  y: number,
  scope: Scope = EMPTY_SCOPE,
): { px: Dual; py: Dual } {
  return {
    px: evalDual(F.x, x, y, 0, scope),
    py: evalDual(F.y, x, y, 0, scope),
  };
}

export function evalField(
  F: Field2,
  x: number,
  y: number,
  scope: Scope = EMPTY_SCOPE,
): Pt {
  const { px, py } = fieldDuals(F, x, y, scope);
  return { x: px.v, y: py.v };
}

/** ∇·F = ∂P/∂x + ∂Q/∂y at a point. */
export function divergence(
  F: Field2,
  x: number,
  y: number,
  scope: Scope = EMPTY_SCOPE,
): number {
  const { px, py } = fieldDuals(F, x, y, scope);
  return px.dx + py.dy;
}

/** The scalar curl ∂Q/∂x − ∂P/∂y at a point (the k̂ component of ∇×F). */
export function curl(
  F: Field2,
  x: number,
  y: number,
  scope: Scope = EMPTY_SCOPE,
): number {
  const { px, py } = fieldDuals(F, x, y, scope);
  return py.dx - px.dy;
}

/**
 * Is the field ill-behaved here? Non-finite value or partial means a
 * singularity — the thing that makes Green's hypotheses fail, so it is
 * reported rather than smoothed over.
 */
export function isSingularAt(
  F: Field2,
  x: number,
  y: number,
  scope: Scope = EMPTY_SCOPE,
): boolean {
  try {
    const { px, py } = fieldDuals(F, x, y, scope);
    return !(
      Number.isFinite(px.v) &&
      Number.isFinite(py.v) &&
      Number.isFinite(px.dx) &&
      Number.isFinite(px.dy) &&
      Number.isFinite(py.dx) &&
      Number.isFinite(py.dy)
    );
  } catch {
    return true;
  }
}

/** Why a sample has no drawable vector. */
export type Undrawable = "singular" | "overflow";

/**
 * A double runs out of exponent at ~1.8e308, so a field that is perfectly
 * well defined can still evaluate to Infinity: `(e^x, 2)` does it past x ≈ 709.
 * Reporting that as a singularity is wrong — nothing is undefined there, the
 * *number* merely left the range we can represent — and it is the kind of wrong
 * that teaches a false fact about the field.
 *
 * The two cases look different in a neighbourhood, and that is what this tests.
 * Around a pole the field is an isolated spike: step away by `probe` and the
 * magnitude is back to ordinary numbers. Around an overflow the field is
 * enormous *everywhere* nearby, because it got there by growing smoothly.
 *
 * So: take the largest finite magnitude among eight neighbours at radius
 * `probe`. If nothing nearby is even finite, or the nearest finite value is
 * itself astronomical, this is overflow. Otherwise it is a genuine singularity.
 */
export function classifyNonFinite(
  F: Field2,
  x: number,
  y: number,
  probe: number,
  scope: Scope = EMPTY_SCOPE,
): Undrawable {
  // Far above any magnitude a real scene reaches, far below the 1.8e308 ceiling:
  // a pole would have to sit within 1e-150 of the sample to reach this, and at
  // that distance either verdict draws the same mark in the same place.
  const ASTRONOMICAL = 1e150;
  let maxFinite = -1;
  for (const [ox, oy] of [
    [probe, 0],
    [-probe, 0],
    [0, probe],
    [0, -probe],
    [probe, probe],
    [probe, -probe],
    [-probe, probe],
    [-probe, -probe],
  ]) {
    try {
      const v = evalField(F, x + ox, y + oy, scope);
      const m = Math.hypot(v.x, v.y);
      if (Number.isFinite(m) && m > maxFinite) maxFinite = m;
    } catch {
      // An evaluation error is not evidence either way; keep looking.
    }
  }
  if (maxFinite < 0) return "overflow"; // a whole region out of range is not a pole
  return maxFinite >= ASTRONOMICAL ? "overflow" : "singular";
}

// ---------------------------------------------------------------------------
// The symbolic path — exact text when the field is polynomial
// ---------------------------------------------------------------------------

/** div F as an exact polynomial, or null when the field isn't polynomial. */
export function divPoly(F: Field2, scope: Scope = EMPTY_SCOPE): Poly | null {
  const p = toPoly(F.x, scope);
  const q = toPoly(F.y, scope);
  if (p === null || q === null) return null;
  return P.add(P.diff(p, 0), P.diff(q, 1));
}

/** curl F as an exact polynomial, or null when the field isn't polynomial. */
export function curlPoly(F: Field2, scope: Scope = EMPTY_SCOPE): Poly | null {
  const p = toPoly(F.x, scope);
  const q = toPoly(F.y, scope);
  if (p === null || q === null) return null;
  return P.add(P.diff(q, 0), P.diff(p, 1), -1);
}

// ---------------------------------------------------------------------------
// Symbolic differentiation of elementary expressions — for grad()
// ---------------------------------------------------------------------------

const num = (v: number): Node => ({ t: "num", v });
const nAdd = (a: Node, b: Node): Node => ({ t: "add", a, b });
const nSub = (a: Node, b: Node): Node => ({ t: "sub", a, b });
const nMul = (a: Node, b: Node): Node => ({ t: "mul", a, b });
const nDiv = (a: Node, b: Node): Node => ({ t: "div", a, b });
const nPow = (a: Node, b: Node): Node => ({ t: "pow", a, b });
const nNeg = (a: Node): Node => ({ t: "neg", a });
const call = (fn: ElemFn, args: Node[]): Node => ({ t: "call", fn, args });

/** Is this node the literal zero? Cheap simplification so grad output stays readable. */
const isZero = (n: Node): boolean => n.t === "num" && n.v === 0;
const isOne = (n: Node): boolean => n.t === "num" && n.v === 1;

const sAdd = (a: Node, b: Node): Node =>
  isZero(a) ? b : isZero(b) ? a : nAdd(a, b);
const sSub = (a: Node, b: Node): Node =>
  isZero(b) ? a : isZero(a) ? nNeg(b) : nSub(a, b);
const sMul = (a: Node, b: Node): Node =>
  isZero(a) || isZero(b) ? num(0) : isOne(a) ? b : isOne(b) ? a : nMul(a, b);

/**
 * ∂node/∂axis, symbolically. Used to build gradient fields, which is why it
 * exists at all: a potential's gradient should be a *field* the rest of the
 * pipeline treats like any other (graphable, integrable, printable when
 * polynomial), not a special case.
 *
 * `abs`, `min`, and `max` are not differentiable, and say so rather than
 * quietly returning a wrong derivative at the kink.
 */
export function diffNode(node: Node, axis: 0 | 1 | 2): Node {
  const d = (n: Node) => diffNode(n, axis);
  switch (node.t) {
    case "num":
    case "ref":
      return num(0);
    case "sym":
      return num(node.axis === axis ? 1 : 0);
    case "neg":
      return nNeg(d(node.a));
    case "add":
      return sAdd(d(node.a), d(node.b));
    case "sub":
      return sSub(d(node.a), d(node.b));
    case "mul":
      return sAdd(sMul(d(node.a), node.b), sMul(node.a, d(node.b)));
    case "div":
      return nDiv(
        sSub(sMul(d(node.a), node.b), sMul(node.a, d(node.b))),
        nPow(node.b, num(2)),
      );
    case "pow": {
      const { a, b } = node;
      const da = d(a);
      if (isConstantIn(b)) {
        // Power rule: d(aⁿ) = n·aⁿ⁻¹·a'
        if (isZero(da)) return num(0);
        return sMul(sMul(b, nPow(a, sSub(b, num(1)))), da);
      }
      // General: aᵇ·(b'·ln a + b·a'/a)
      const db = d(b);
      return sMul(
        nPow(a, b),
        sAdd(sMul(db, call("ln", [a])), nDiv(sMul(b, da), a)),
      );
    }
    case "call": {
      const [u, w] = node.args;
      const du = d(u);
      switch (node.fn) {
        case "sin":
          return sMul(call("cos", [u]), du);
        case "cos":
          return nNeg(sMul(call("sin", [u]), du));
        case "tan":
          return nDiv(du, nPow(call("cos", [u]), num(2)));
        case "asin":
          return nDiv(du, call("sqrt", [sSub(num(1), nPow(u, num(2)))]));
        case "acos":
          return nNeg(nDiv(du, call("sqrt", [sSub(num(1), nPow(u, num(2)))])));
        case "atan":
          return nDiv(du, sAdd(num(1), nPow(u, num(2))));
        case "exp":
          return sMul(call("exp", [u]), du);
        case "ln":
        case "log":
          return nDiv(du, u);
        case "log2":
          return nDiv(du, sMul(u, num(Math.LN2)));
        case "sqrt":
          return nDiv(du, sMul(num(2), call("sqrt", [u])));
        case "cbrt":
          return nDiv(du, sMul(num(3), nPow(call("cbrt", [u]), num(2))));
        case "sinh":
          return sMul(call("cosh", [u]), du);
        case "cosh":
          return sMul(call("sinh", [u]), du);
        case "tanh":
          return sMul(sSub(num(1), nPow(call("tanh", [u]), num(2))), du);
        case "atan2": {
          // atan2(u, w): (w·u' − u·w') / (u² + w²)
          const dw = d(w);
          return nDiv(
            sSub(sMul(w, du), sMul(u, dw)),
            sAdd(nPow(u, num(2)), nPow(w, num(2))),
          );
        }
        case "hypot": {
          const dw = d(w);
          return nDiv(
            sAdd(sMul(u, du), sMul(w, dw)),
            call("hypot", [u, w]),
          );
        }
        case "abs":
        case "min":
        case "max":
          throw new ElemError(`${node.fn}() has no derivative at its corner`);
      }
    }
  }
}

/** ∇f — the gradient field of a scalar potential. */
export function gradient(f: Node): Field2 {
  return { x: diffNode(f, 0), y: diffNode(f, 1) };
}

/** ∇²f = ∂²f/∂x² + ∂²f/∂y². */
export function laplacian(f: Node): Node {
  return sAdd(diffNode(diffNode(f, 0), 0), diffNode(diffNode(f, 1), 1));
}

// ---------------------------------------------------------------------------
// Curves and the boundary integrals
// ---------------------------------------------------------------------------

/**
 * A curve as Flux integrates it: position and velocity in the parameter, plus
 * the parameter values where it has corners. Panels never straddle a break, so
 * a dragged polyline's vertices don't wreck the smooth-integrand assumption
 * Gauss quadrature is built on.
 */
export interface Curve {
  at: (t: number) => Pt;
  velocity: (t: number) => Pt;
  /** Ascending; first and last are the endpoints of integration. */
  breaks: number[];
  closed: boolean;
}

/** A closed polyline (a dragged loop) as a Curve, with a break per vertex. */
export function polylineCurve(pts: readonly Pt[], closed: boolean): Curve {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const breaks = Array.from({ length: segs + 1 }, (_, i) => i);
  const seg = (t: number) => {
    const i = Math.min(Math.max(Math.floor(t), 0), segs - 1);
    return { i, f: t - i };
  };
  return {
    at: (t) => {
      const { i, f } = seg(t);
      const a = pts[i];
      const b = pts[(i + 1) % n];
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
    },
    velocity: (t) => {
      const { i } = seg(t);
      const a = pts[i];
      const b = pts[(i + 1) % n];
      return { x: b.x - a.x, y: b.y - a.y };
    },
    breaks,
    closed,
  };
}

/** A parameterized curve from two expressions in the parameter `t`. */
export function paramCurve(
  fx: (t: number) => number,
  fy: (t: number) => number,
  t0: number,
  t1: number,
  closed: boolean,
  panels = 1,
): Curve {
  const h = 1e-6 * Math.max(1, Math.abs(t1 - t0));
  const breaks = Array.from(
    { length: panels + 1 },
    (_, i) => t0 + ((t1 - t0) * i) / panels,
  );
  return {
    at: (t) => ({ x: fx(t), y: fy(t) }),
    // Central difference on the *parameterization* only — the field's own
    // derivatives always come from dual numbers, never from differencing.
    velocity: (t) => ({
      x: (fx(t + h) - fx(t - h)) / (2 * h),
      y: (fy(t + h) - fy(t - h)) / (2 * h),
    }),
    breaks,
    closed,
  };
}

const integrate = (
  f: (t: number) => number,
  c: Curve,
  tol?: number,
): Quad =>
  c.breaks.length > 2
    ? piecewiseQuad(f, c.breaks, { tol })
    : adaptiveQuad(f, c.breaks[0], c.breaks[c.breaks.length - 1], { tol });

/**
 * ∫_C F·dr — work along the curve (circulation, when C is closed).
 * F·dr = (P·x' + Q·y') dt, so no arc-length normalization is needed.
 */
export function work(
  F: Field2,
  c: Curve,
  scope: Scope = EMPTY_SCOPE,
  tol?: number,
): Quad {
  return integrate(
    (t) => {
      const p = c.at(t);
      const v = c.velocity(t);
      const f = evalField(F, p.x, p.y, scope);
      return f.x * v.x + f.y * v.y;
    },
    c,
    tol,
  );
}

/**
 * ∫_C F·n̂ ds — outward flux across the curve.
 *
 * For a counter-clockwise curve the outward normal is (y', −x')/|r'|, and
 * ds = |r'| dt, so the whole integrand collapses to (P·y' − Q·x') dt — the
 * normalization cancels exactly, which is both faster and avoids a division
 * by zero wherever the parameterization momentarily stalls.
 */
export function flux(
  F: Field2,
  c: Curve,
  scope: Scope = EMPTY_SCOPE,
  tol?: number,
): Quad {
  return integrate(
    (t) => {
      const p = c.at(t);
      const v = c.velocity(t);
      const f = evalField(F, p.x, p.y, scope);
      return f.x * v.y - f.y * v.x;
    },
    c,
    tol,
  );
}

/** ∫_C ds — arc length, for average-value readouts. */
export function arcLength(c: Curve, tol?: number): Quad {
  return integrate(
    (t) => {
      const v = c.velocity(t);
      return Math.hypot(v.x, v.y);
    },
    c,
    tol,
  );
}

/** Sample a curve into a polyline, for drawing and for polygonizing a region. */
export function samplePolyline(c: Curve, steps = 512): Pt[] {
  const t0 = c.breaks[0];
  const t1 = c.breaks[c.breaks.length - 1];
  const out: Pt[] = [];
  const n = c.closed ? steps : steps + 1;
  for (let i = 0; i < n; i++) out.push(c.at(t0 + ((t1 - t0) * i) / steps));
  return out;
}
