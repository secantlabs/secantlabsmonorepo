/**
 * Numerical integration and polygon geometry.
 *
 * Flux's signature feature shows both sides of Green's theorem at once and
 * claims they are equal. That claim is only worth anything if the two sides
 * are computed by *genuinely different* methods — a boundary integral by
 * quadrature along the parameterized curve, an interior integral by
 * quadrature over a triangulation of the region. Deriving one from the other
 * (via the very theorem being demonstrated) would make the agreement a
 * tautology and the whole feature a lie. Hence two independent routines here,
 * and no path between them.
 *
 * Every routine reports an error estimate alongside its value, so agreement
 * can be shown with an error bar rather than asserted.
 *
 * Pure, no rendering deps.
 */

export interface Quad {
  /** The estimated integral. */
  value: number;
  /** Estimated absolute error — the Theorem Bar's Δ tolerance comes from this. */
  error: number;
  /** Integrand evaluations spent, for the refine control's cost display. */
  evals: number;
}

export interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Gauss–Legendre nodes
// ---------------------------------------------------------------------------

interface Rule {
  nodes: number[]; // on [-1, 1]
  weights: number[];
}

const ruleCache = new Map<number, Rule>();

/** P_n(x) and P_n'(x) by the three-term recurrence. */
function legendre(n: number, x: number): { p: number; dp: number } {
  let pPrev = 1; // P_0
  let p = x; // P_1
  for (let k = 2; k <= n; k++) {
    const pk = ((2 * k - 1) * x * p - (k - 1) * pPrev) / k;
    pPrev = p;
    p = pk;
  }
  const dp = (n * (x * p - pPrev)) / (x * x - 1);
  return { p, dp };
}

/**
 * The n-point Gauss–Legendre rule on [-1, 1], exact for polynomials of degree
 * up to 2n−1. Nodes are the roots of P_n, found by Newton from the standard
 * Chebyshev-like initial guess; weights follow from P_n'.
 */
export function gaussLegendre(n: number): Rule {
  const cached = ruleCache.get(n);
  if (cached) return cached;
  if (n < 1 || !Number.isInteger(n)) throw new Error(`Bad quadrature order ${n}`);

  const nodes: number[] = new Array(n);
  const weights: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Roots are symmetric; solve for each from a good initial guess.
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    for (let iter = 0; iter < 100; iter++) {
      const { p, dp } = legendre(n, x);
      const dxStep = p / dp;
      x -= dxStep;
      if (Math.abs(dxStep) < 1e-15) break;
    }
    const { dp } = legendre(n, x);
    nodes[i] = x;
    weights[i] = 2 / ((1 - x * x) * dp * dp);
  }
  const rule = { nodes, weights };
  ruleCache.set(n, rule);
  return rule;
}

// ---------------------------------------------------------------------------
// One-dimensional integration — the boundary side
// ---------------------------------------------------------------------------

/** Fixed-order Gauss–Legendre over [a, b]. */
export function gaussQuad(
  f: (t: number) => number,
  a: number,
  b: number,
  n = 10,
): number {
  const { nodes, weights } = gaussLegendre(n);
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += weights[i] * f(mid + half * nodes[i]);
  return sum * half;
}

const DEFAULT_TOL = 1e-10;
const MAX_DEPTH = 14;

/**
 * Adaptive Gauss–Legendre: compare the rule over the whole interval against
 * the same rule over each half, and subdivide where they disagree. The
 * difference is a genuine error estimate, and subdivision concentrates work
 * exactly where the integrand moves fastest — which for a field near a
 * singularity is the only way to get a trustworthy number.
 */
export function adaptiveQuad(
  f: (t: number) => number,
  a: number,
  b: number,
  opts: { order?: number; tol?: number; maxDepth?: number } = {},
): Quad {
  const order = opts.order ?? 10;
  const tol = opts.tol ?? DEFAULT_TOL;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  let evals = 0;
  const count = (t: number) => {
    evals++;
    return f(t);
  };

  const go = (lo: number, hi: number, localTol: number, depth: number): Quad => {
    const whole = gaussQuad(count, lo, hi, order);
    const mid = (lo + hi) / 2;
    const left = gaussQuad(count, lo, mid, order);
    const right = gaussQuad(count, mid, hi, order);
    const split = left + right;
    const err = Math.abs(split - whole);
    if (!Number.isFinite(split)) return { value: split, error: Infinity, evals };
    if (err <= localTol || depth >= maxDepth)
      return { value: split, error: err, evals };
    const l = go(lo, mid, localTol / 2, depth + 1);
    const r = go(mid, hi, localTol / 2, depth + 1);
    return { value: l.value + r.value, error: l.error + r.error, evals };
  };

  if (a === b) return { value: 0, error: 0, evals: 0 };
  return go(a, b, tol, 0);
}

/**
 * Integrate over a piecewise parameterization — one adaptive call per piece,
 * with errors summed. Dragged polylines integrate segment-wise this way, so a
 * corner never sits inside a quadrature panel (where it would quietly wreck
 * the convergence a smooth rule assumes).
 */
export function piecewiseQuad(
  f: (t: number) => number,
  breaks: number[],
  opts: { order?: number; tol?: number } = {},
): Quad {
  let value = 0;
  let error = 0;
  let evals = 0;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const q = adaptiveQuad(f, breaks[i], breaks[i + 1], opts);
    value += q.value;
    error += q.error;
    evals += q.evals;
  }
  return { value, error, evals };
}

// ---------------------------------------------------------------------------
// Polygon geometry
// ---------------------------------------------------------------------------

/** Twice the signed area (the shoelace sum). Positive when counter-clockwise. */
export function shoelace(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/** Signed area; positive counter-clockwise, negative clockwise. */
export const signedArea = (pts: readonly Pt[]): number => shoelace(pts) / 2;

const cross3 = (o: Pt, a: Pt, b: Pt): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const EPS = 1e-12;

function onSegment(p: Pt, q: Pt, r: Pt): boolean {
  return (
    Math.min(p.x, r.x) - EPS <= q.x &&
    q.x <= Math.max(p.x, r.x) + EPS &&
    Math.min(p.y, r.y) - EPS <= q.y &&
    q.y <= Math.max(p.y, r.y) + EPS
  );
}

/** Do segments p1p2 and p3p4 properly cross (or overlap collinearly)? */
function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross3(p3, p4, p1);
  const d2 = cross3(p3, p4, p2);
  const d3 = cross3(p1, p2, p3);
  const d4 = cross3(p1, p2, p4);
  if (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  )
    return true;
  // Collinear touching counts — a loop that doubles back over itself has no
  // well-defined interior either.
  if (Math.abs(d1) <= EPS && onSegment(p3, p1, p4)) return true;
  if (Math.abs(d2) <= EPS && onSegment(p3, p2, p4)) return true;
  if (Math.abs(d3) <= EPS && onSegment(p1, p3, p2)) return true;
  if (Math.abs(d4) <= EPS && onSegment(p1, p4, p2)) return true;
  return false;
}

/**
 * Does this closed polygon cross itself?
 *
 * A hand-dragged loop the user pulled across its own path has **no
 * well-defined interior**, so integrating over it would be integrating over a
 * guess. Flux treats that as a first-class state of the region row and says so,
 * the same way it refuses to apply Green's theorem across a singularity.
 * O(n²), which is nothing at the few-hundred-vertex scale a dragged loop
 * reaches.
 */
export function selfIntersects(pts: readonly Pt[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip the pair sharing a vertex, and the closing edge against the first.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(a1, a2, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Drop consecutive duplicates (and a closing point that repeats the first). */
export function dedupe(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <
      1e-9
  )
    out.pop();
  return out;
}

export interface Triangle {
  a: Pt;
  b: Pt;
  c: Pt;
}

function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross3(a, b, p);
  const d2 = cross3(b, c, p);
  const d3 = cross3(c, a, p);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon. Returns null when the input
 * isn't triangulable (fewer than three distinct vertices, or self-intersecting
 * — check `selfIntersects` first for a better message).
 *
 * This is the interior side of the Theorem Bar. It must stay independent of
 * the boundary integral: the whole point is that two unrelated computations
 * land on the same number.
 */
export function triangulate(input: readonly Pt[]): Triangle[] | null {
  const pts = dedupe(input);
  if (pts.length < 3) return null;

  // Work counter-clockwise so the ear test has a consistent sign.
  const ccw = signedArea(pts) >= 0 ? pts : [...pts].reverse();
  const idx = ccw.map((_, i) => i);
  const out: Triangle[] = [];

  let guard = idx.length * idx.length + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = ccw[ia];
      const b = ccw[ib];
      const c = ccw[ic];
      if (cross3(a, b, c) <= EPS) continue; // reflex or degenerate — not an ear

      let contains = false;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (pointInTriangle(ccw[k], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      out.push({ a, b, c });
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null; // no ear found: not a simple polygon
  }
  if (idx.length !== 3) return null;
  out.push({ a: ccw[idx[0]], b: ccw[idx[1]], c: ccw[idx[2]] });
  return out;
}

// ---------------------------------------------------------------------------
// Two-dimensional integration — the interior side
// ---------------------------------------------------------------------------

const triArea = (t: Triangle): number =>
  Math.abs(cross3(t.a, t.b, t.c)) / 2;

/**
 * ∬ over one triangle, by the Duffy transform: the unit square maps onto the
 * reference triangle with Jacobian (1 − u), which turns a tensor-product
 * Gauss rule into a triangle rule. Straightforward and easy to verify against
 * known polynomial integrals, which matters more here than shaving nodes.
 */
export function triangleIntegral(
  g: (x: number, y: number) => number,
  t: Triangle,
  n = 8,
): number {
  const { nodes, weights } = gaussLegendre(n);
  const area2 = 2 * triArea(t);
  // Gauss nodes are on [-1,1]; shift to [0,1].
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const u = (nodes[i] + 1) / 2;
    const wu = weights[i] / 2;
    for (let j = 0; j < n; j++) {
      const v = (nodes[j] + 1) / 2;
      const wv = weights[j] / 2;
      const l1 = u;
      const l2 = v * (1 - u);
      const l3 = 1 - l1 - l2;
      const x = l3 * t.a.x + l1 * t.b.x + l2 * t.c.x;
      const y = l3 * t.a.y + l1 * t.b.y + l2 * t.c.y;
      sum += wu * wv * (1 - u) * g(x, y);
    }
  }
  return sum * area2;
}

/**
 * ∬_R g dA over a polygonal region, by triangulating and summing. The error
 * estimate compares two orders — honest about sampling, and it is what the
 * refine control drives down.
 *
 * Returns null when the polygon can't be triangulated.
 */
export function polygonIntegral(
  g: (x: number, y: number) => number,
  pts: readonly Pt[],
  opts: { order?: number } = {},
): Quad | null {
  const tris = triangulate(pts);
  if (!tris) return null;
  const order = opts.order ?? 8;
  let evals = 0;
  const count = (x: number, y: number) => {
    evals++;
    return g(x, y);
  };

  let coarse = 0;
  let fine = 0;
  for (const t of tris) {
    coarse += triangleIntegral(count, t, Math.max(2, order - 3));
    fine += triangleIntegral(count, t, order);
  }
  // The region's own orientation decides the sign, matching ∮ counter-clockwise.
  const sign = signedArea(pts) >= 0 ? 1 : -1;
  return {
    value: sign * fine,
    error: Math.abs(fine - coarse),
    evals,
  };
}

/**
 * ∬ over an axis-aligned rectangle by a tensor-product Gauss rule — cheaper
 * and more accurate than triangulating a shape whose geometry is exact.
 */
export function rectIntegral(
  g: (x: number, y: number) => number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: { order?: number } = {},
): Quad {
  const order = opts.order ?? 10;
  let evals = 0;
  const count = (x: number, y: number) => {
    evals++;
    return g(x, y);
  };
  const run = (n: number) =>
    gaussQuad((x) => gaussQuad((y) => count(x, y), y0, y1, n), x0, x1, n);
  const fine = run(order);
  const coarse = run(Math.max(2, order - 3));
  return { value: fine, error: Math.abs(fine - coarse), evals };
}

/**
 * ∬ over a disk in polar coordinates: ∫∫ g(r,θ) r dr dθ with Gauss in r and
 * the trapezoid/midpoint rule in θ (periodic, so equal spacing is optimal —
 * Gauss buys nothing around a full circle). Exact geometry, so no
 * polygonization error creeps into the theorem's interior side.
 */
export function diskIntegral(
  g: (x: number, y: number) => number,
  cx: number,
  cy: number,
  R: number,
  opts: { radial?: number; angular?: number } = {},
): Quad {
  const nr = opts.radial ?? 12;
  const nt = opts.angular ?? 96;
  let evals = 0;
  const count = (x: number, y: number) => {
    evals++;
    return g(x, y);
  };

  const run = (radial: number, angular: number) => {
    const { nodes, weights } = gaussLegendre(radial);
    let total = 0;
    for (let k = 0; k < angular; k++) {
      const th = (2 * Math.PI * (k + 0.5)) / angular;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      let inner = 0;
      for (let i = 0; i < radial; i++) {
        const r = (R * (nodes[i] + 1)) / 2;
        inner += (weights[i] * R) / 2 * r * count(cx + r * ct, cy + r * st);
      }
      total += inner;
    }
    return (total * 2 * Math.PI) / angular;
  };

  const fine = run(nr, nt);
  const coarse = run(Math.max(2, nr - 4), Math.max(8, nt >> 1));
  return { value: fine, error: Math.abs(fine - coarse), evals };
}
