/**
 * Parameterized curves — `r(t) = (x(t), y(t))` over an interval.
 *
 * The components are parsed with `t` bound to the first axis and polar sugar
 * off, so `r` inside a parameterization is an unbound name (an error the row
 * reports) rather than silently meaning √(t²).
 *
 * v0.2 has one geometric object beyond fields and points. The region machinery —
 * disks, rectangles, hand-dragged loops, triangulated interiors — is shelved
 * with the measurement layer; its engine (`quad.ts`) is still tested and intact,
 * so bringing it back is interface work. See the PRD's §13.
 */

import {
  paramCurve,
  samplePolyline,
  type Curve,
} from "@secantlabs/engine/field";
import { type Pt } from "@secantlabs/engine/quad";
import { evalAt, PARAM_OPTS, tryParse, type Scope } from "@secantlabs/engine/elem";

export interface ResolvedCurve {
  curve: Curve;
  /** Sampled points, for drawing. */
  points: Pt[];
  closed: boolean;
  t0: number;
  t1: number;
}

/** Panels the adaptive quadrature starts from — one per quarter turn is plenty. */
const PANELS = 8;
const DRAW_STEPS = 512;

export function resolveParamCurve(
  srcX: string,
  srcY: string,
  t0src: string,
  t1src: string,
  scope: Scope,
): { ok: ResolvedCurve } | { error: string } {
  const opts = PARAM_OPTS("t");
  const nx = tryParse(srcX, opts);
  const ny = tryParse(srcY, opts);
  if (!nx || !ny) return { error: "Can't read that parameterization" };
  const nt0 = tryParse(t0src, opts);
  const nt1 = tryParse(t1src, opts);
  if (!nt0 || !nt1) return { error: "Can't read the t range" };

  let t0: number;
  let t1: number;
  try {
    t0 = evalAt(nt0, 0, 0, 0, scope);
    t1 = evalAt(nt1, 0, 0, 0, scope);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bad t range" };
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1))
    return { error: "The t range must be finite" };
  if (t0 === t1) return { error: "The t range is empty" };

  const fx = (t: number) => evalAt(nx, t, 0, 0, scope);
  const fy = (t: number) => evalAt(ny, t, 0, 0, scope);
  try {
    fx(t0);
    fy(t0);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Can't evaluate" };
  }

  // Closure is read off the geometry rather than asked for: a curve whose ends
  // meet is closed whether or not anyone said so, and that's the only thing
  // "closed" affects here (whether the drawn path joins up).
  const a = { x: fx(t0), y: fy(t0) };
  const b = { x: fx(t1), y: fy(t1) };
  const closed =
    Number.isFinite(a.x) &&
    Number.isFinite(b.x) &&
    Math.hypot(a.x - b.x, a.y - b.y) < 1e-7 * (1 + Math.hypot(a.x, a.y));

  const curve = paramCurve(fx, fy, t0, t1, closed, PANELS);
  return {
    ok: {
      curve,
      points: samplePolyline(curve, DRAW_STEPS),
      closed,
      t0,
      t1,
    },
  };
}
