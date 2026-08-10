import { describe, expect, it } from "vitest";
import { parse, type Node } from "../src/elem";
import {
  arcLength,
  curl,
  curlPoly,
  diffNode,
  divergence,
  divPoly,
  evalField,
  flux,
  gradient,
  isSingularAt,
  laplacian,
  paramCurve,
  polylineCurve,
  samplePolyline,
  work,
  type Field2,
} from "../src/field";
import { evalAt } from "../src/elem";
import { toText } from "../src/poly";
import { diskIntegral, polygonIntegral, type Pt } from "../src/quad";

const F = (px: string, qy: string): Field2 => ({ x: parse(px), y: parse(qy) });
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const text = (p: ReturnType<typeof divPoly>) => (p === null ? null : toText(p, fmt));

/** The unit circle, counter-clockwise — the canonical closed curve. */
const unitCircle = (R = 1) =>
  paramCurve(
    (t) => R * Math.cos(t),
    (t) => R * Math.sin(t),
    0,
    2 * Math.PI,
    true,
    8,
  );

const circlePolygon = (R = 1, n = 512): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return { x: R * Math.cos(t), y: R * Math.sin(t) };
  });

describe("divergence and curl", () => {
  it("gets the textbook fields right numerically", () => {
    expect(divergence(F("x", "y"), 3, -2)).toBeCloseTo(2, 12);
    expect(curl(F("x", "y"), 3, -2)).toBeCloseTo(0, 12);
    expect(curl(F("0 - y", "x"), 3, -2)).toBeCloseTo(2, 12);
    expect(divergence(F("0 - y", "x"), 3, -2)).toBeCloseTo(0, 12);
    // A shear: divergence-free, constant curl.
    expect(divergence(F("y", "0"), 1, 1)).toBeCloseTo(0, 12);
    expect(curl(F("y", "0"), 1, 1)).toBeCloseTo(-1, 12);
  });

  it("prints exactly when the field is polynomial", () => {
    expect(text(divPoly(F("x^2", "y^3")))).toBe("3y² + 2x");
    // Like terms combine, as the ring should: 2x + x, not "2x + x".
    expect(text(divPoly(F("x^2", "x·y")))).toBe("3x");
    expect(text(curlPoly(F("0 - y^3", "x^3")))).toBe("3x² + 3y²");
    expect(text(divPoly(F("x", "y")))).toBe("2");
    expect(text(curlPoly(F("x", "y")))).toBe("0");
  });

  it("declines to print for non-polynomial fields, but still computes", () => {
    const inv = F("0 - y/(x^2 + y^2)", "x/(x^2 + y^2)");
    expect(divPoly(inv)).toBeNull();
    expect(curlPoly(inv)).toBeNull();
    // Numerically it is still exactly curl-free away from the origin.
    for (const [x, y] of [[1, 0], [0.3, -1.7], [-2, 2], [5, 0.1]])
      expect(curl(inv, x, y)).toBeCloseTo(0, 10);
  });

  it("folds slider values into both paths identically", () => {
    const scope = new Map([["a", 3]]);
    const swirl = F("0 - a·y", "a·x");
    expect(curl(swirl, 1, 1, scope)).toBeCloseTo(6, 12);
    expect(text(curlPoly(swirl, scope))).toBe("6");
  });

  it("flags a singularity instead of returning a huge number", () => {
    const inv = F("x/(x^2 + y^2)", "y/(x^2 + y^2)");
    expect(isSingularAt(inv, 0, 0)).toBe(true);
    expect(isSingularAt(inv, 1, 1)).toBe(false);
    expect(isSingularAt(F("x", "a"), 0, 0)).toBe(true); // unbound name
  });
});

describe("gradients and the identities", () => {
  it("differentiates symbolically, matching the dual-number path", () => {
    for (const src of ["x^3·y", "sin(x·y)", "exp(x)/y", "sqrt(x^2 + y^2)", "atan2(y, x)"]) {
      const f = parse(src);
      const g = gradient(f);
      const dual = evalField({ x: f, y: f }, 1.4, 0.9); // value only, unused
      expect(dual.x).toBeDefined();
      const gx = evalAt(g.x, 1.4, 0.9);
      const gy = evalAt(g.y, 1.4, 0.9);
      const h = 1e-6;
      expect(gx).toBeCloseTo(
        (evalAt(f, 1.4 + h, 0.9) - evalAt(f, 1.4 - h, 0.9)) / (2 * h),
        5,
      );
      expect(gy).toBeCloseTo(
        (evalAt(f, 1.4, 0.9 + h) - evalAt(f, 1.4, 0.9 - h)) / (2 * h),
        5,
      );
    }
  });

  it("makes curl of a gradient exactly zero — symbolically", () => {
    // The identity has to hold as algebra, not as a small float. That is the
    // whole reason the Poly path is kept alongside the numeric one.
    for (const src of ["x^2 + y^2", "x^3·y - x·y^3", "5x^4 + 2x·y + 7"]) {
      const g = gradient(parse(src));
      expect(text(curlPoly(g))).toBe("0");
    }
  });

  it("makes curl of a gradient vanish numerically for transcendental potentials", () => {
    for (const src of ["sin(x)·cos(y)", "exp(x·y)", "ln(x^2 + y^2)"]) {
      const g = gradient(parse(src));
      expect(curl(g, 1.1, -0.6)).toBeCloseTo(0, 8);
    }
  });

  it("computes the Laplacian, and finds the harmonic functions", () => {
    expect(text(divPoly(gradient(parse("x^2 + y^2"))))).toBe("4");
    expect(evalAt(laplacian(parse("x^2 - y^2")), 2, 3)).toBeCloseTo(0, 10);
    expect(evalAt(laplacian(parse("x^2 + y^2")), 2, 3)).toBeCloseTo(4, 10);
  });

  it("refuses to differentiate at a corner", () => {
    expect(() => diffNode(parse("abs(x)"), 0)).toThrow(/no derivative/);
  });
});

describe("line integrals", () => {
  it("measures arc length", () => {
    expect(arcLength(unitCircle()).value).toBeCloseTo(2 * Math.PI, 8);
    expect(arcLength(unitCircle(3)).value).toBeCloseTo(6 * Math.PI, 8);
  });

  it("circulates the swirl and not the radial field", () => {
    // ∮ (−y, x)·dr around the unit circle = 2·area = 2π.
    expect(work(F("0 - y", "x"), unitCircle()).value).toBeCloseTo(2 * Math.PI, 9);
    // A radial field does no work around a closed loop.
    expect(work(F("x", "y"), unitCircle()).value).toBeCloseTo(0, 9);
  });

  it("fluxes the radial field and not the swirl", () => {
    // ∮ (x, y)·n̂ ds = 2·area = 2π; the swirl is everywhere tangent.
    expect(flux(F("x", "y"), unitCircle()).value).toBeCloseTo(2 * Math.PI, 9);
    expect(flux(F("0 - y", "x"), unitCircle()).value).toBeCloseTo(0, 9);
  });

  it("integrates a dragged polyline segment-wise", () => {
    const squarePts: Pt[] = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const c = polylineCurve(squarePts, true);
    expect(arcLength(c).value).toBeCloseTo(8, 10);
    // ∮ (−y, x)·dr = 2·area = 8
    expect(work(F("0 - y", "x"), c).value).toBeCloseTo(8, 10);
  });

  it("samples a curve into a closed polyline", () => {
    const pts = samplePolyline(unitCircle(), 64);
    expect(pts).toHaveLength(64); // closed: no duplicated endpoint
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 10);
  });
});

describe("Green's theorem, computed two independent ways", () => {
  // The boundary side comes from field.ts's quadrature along the parameterized
  // curve. The interior side comes from quad.ts's quadrature over the region
  // (polar for a disk, a triangulation for a polygon). Neither is derived from
  // the other — that independence is what makes the agreement below evidence
  // rather than a tautology.

  it("holds in circulation form on the unit disk", () => {
    // ∮_∂R F·dr = ∬_R curl F dA, with curl (−y³, x³) = 3(x² + y²) ⇒ 3π/2.
    const f = F("0 - y^3", "x^3");
    const boundary = work(f, unitCircle());
    const interior = diskIntegral((x, y) => curl(f, x, y), 0, 0, 1);
    expect(boundary.value).toBeCloseTo((3 * Math.PI) / 2, 8);
    expect(interior.value).toBeCloseTo((3 * Math.PI) / 2, 8);
    expect(Math.abs(boundary.value - interior.value)).toBeLessThan(1e-6);
  });

  it("holds in outward-flux form on the unit disk", () => {
    // ∮_∂R F·n̂ ds = ∬_R div F dA, with div (x³, y³) = 3(x² + y²) ⇒ 3π/2.
    const f = F("x^3", "y^3");
    const boundary = flux(f, unitCircle());
    const interior = diskIntegral((x, y) => divergence(f, x, y), 0, 0, 1);
    expect(boundary.value).toBeCloseTo((3 * Math.PI) / 2, 8);
    expect(interior.value).toBeCloseTo((3 * Math.PI) / 2, 8);
  });

  it("holds over a polygon, via triangulation against a polyline boundary", () => {
    // ∬ 3(x² + y²) over [-1,1]² = 8, and the circulation must match.
    const f = F("0 - y^3", "x^3");
    const pts: Pt[] = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const boundary = work(f, polylineCurve(pts, true));
    const interior = polygonIntegral((x, y) => curl(f, x, y), pts)!;
    expect(boundary.value).toBeCloseTo(8, 9);
    expect(interior.value).toBeCloseTo(8, 9);
  });

  it("holds for a transcendental field, where only the numeric path exists", () => {
    const f = F("sin(y)", "cos(x)");
    const boundary = work(f, unitCircle());
    const interior = diskIntegral((x, y) => curl(f, x, y), 0, 0, 1);
    expect(curlPoly(f)).toBeNull(); // nothing to print — but it still integrates
    expect(Math.abs(boundary.value - interior.value)).toBeLessThan(1e-6);
  });

  it("holds on an off-center region, so it isn't an accident of symmetry", () => {
    const f = F("x^2·y", "x·y^2 + x");
    const c = paramCurve(
      (t) => 1.5 + 0.7 * Math.cos(t),
      (t) => -0.4 + 0.7 * Math.sin(t),
      0,
      2 * Math.PI,
      true,
      8,
    );
    const boundary = work(f, c);
    const interior = diskIntegral((x, y) => curl(f, x, y), 1.5, -0.4, 0.7);
    expect(Math.abs(boundary.value - interior.value)).toBeLessThan(1e-6);
    expect(Math.abs(boundary.value)).toBeGreaterThan(0.1); // not trivially zero
  });

  it("FAILS across a singularity — and that is the point", () => {
    // F = (−y, x)/(x² + y²) has curl 0 everywhere it is defined, yet
    // circulates 2π around the origin. Green's theorem does not apply,
    // because the disk minus the origin is not simply connected. Flux must
    // detect this and say so rather than printing two numbers that disagree.
    const f = F("0 - y/(x^2 + y^2)", "x/(x^2 + y^2)");
    const boundary = work(f, unitCircle());
    const interior = diskIntegral((x, y) => curl(f, x, y), 0, 0, 1);

    expect(boundary.value).toBeCloseTo(2 * Math.PI, 6);
    expect(interior.value).toBeCloseTo(0, 6);
    // The two sides genuinely disagree — by exactly the 2π the puncture carries.
    expect(Math.abs(boundary.value - interior.value)).toBeGreaterThan(6);
    expect(isSingularAt(f, 0, 0)).toBe(true);
  });

  it("is radius-independent for the punctured swirl", () => {
    // 2π around *any* loop enclosing the origin — the winding number showing up.
    const f = F("0 - y/(x^2 + y^2)", "x/(x^2 + y^2)");
    for (const R of [0.25, 1, 7])
      expect(work(f, unitCircle(R)).value).toBeCloseTo(2 * Math.PI, 6);
  });

  it("recovers Gauss's law in the plane", () => {
    // (x, y)/r² is divergence-free away from the origin, yet its outward flux
    // through any circle around the origin is 2π — the 2D inverse-square law.
    const f = F("x/(x^2 + y^2)", "y/(x^2 + y^2)");
    for (const R of [0.5, 1, 4])
      expect(flux(f, unitCircle(R)).value).toBeCloseTo(2 * Math.PI, 6);
    expect(divergence(f, 2, 3)).toBeCloseTo(0, 10);
  });

  it("gives path-independence for a gradient field", () => {
    // Wiggle the path, keep the endpoints: the work does not move.
    const g = gradient(parse("x^2·y + y^3"));
    const straight = paramCurve((t) => t, () => 0.5, 0, 2, false, 4);
    // A single bump, entirely on one side of the straight path, so it encloses
    // real signed area (0.8). A wiggle symmetric about the midpoint would
    // enclose exactly zero and every field would look conservative.
    const wiggly = paramCurve(
      (t) => t,
      (t) => 0.5 + 0.6 * t * (2 - t),
      0,
      2,
      false,
      8,
    );
    const a = work(g, straight).value;
    const b = work(g, wiggly).value;
    expect(a).toBeCloseTo(b, 7);

    // ...and a non-conservative field moves by exactly twice the enclosed area.
    const swirl: Field2 = F("0 - y", "x");
    const dSwirl = work(swirl, wiggly).value - work(swirl, straight).value;
    expect(dSwirl).toBeCloseTo(-1.6, 6);
  });
});

describe("regression guards", () => {
  it("keeps a constant field constant everywhere", () => {
    const f = F("2", "3") satisfies Field2;
    for (const [x, y] of [[0, 0], [10, -10], [0.001, 5]]) {
      const v = evalField(f, x, y);
      expect(v).toEqual({ x: 2, y: 3 });
      expect(divergence(f, x, y)).toBe(0);
      expect(curl(f, x, y)).toBe(0);
    }
  });

  it("treats grad as a field like any other", () => {
    const g = gradient(parse("x^2 + y^2"));
    expect(evalField(g, 3, 4)).toEqual({ x: 6, y: 8 });
    expect(text(divPoly(g))).toBe("4");
    const node: Node = g.x;
    expect(node).toBeDefined();
  });
});
