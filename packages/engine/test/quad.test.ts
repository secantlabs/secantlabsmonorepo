import { describe, expect, it } from "vitest";
import {
  adaptiveQuad,
  dedupe,
  diskIntegral,
  gaussLegendre,
  gaussQuad,
  piecewiseQuad,
  polygonIntegral,
  rectIntegral,
  selfIntersects,
  signedArea,
  triangleIntegral,
  triangulate,
  type Pt,
} from "../src/quad";

const sq = (n: number) => n * n;

describe("Gauss–Legendre rules", () => {
  it("has weights summing to the interval length", () => {
    for (const n of [1, 2, 3, 5, 8, 12, 20]) {
      const { weights } = gaussLegendre(n);
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 12);
    }
  });

  it("puts nodes strictly inside and symmetric about zero", () => {
    const { nodes } = gaussLegendre(9);
    for (const x of nodes) expect(Math.abs(x)).toBeLessThan(1);
    const sorted = [...nodes].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++)
      expect(sorted[i]).toBeCloseTo(-sorted[sorted.length - 1 - i], 12);
  });

  it("is exact for polynomials up to degree 2n−1", () => {
    // n = 3 integrates degree 5 exactly: ∫₀¹ x⁵ = 1/6.
    expect(gaussQuad((x) => x ** 5, 0, 1, 3)).toBeCloseTo(1 / 6, 14);
    // ...and degree 6 is where it must stop being exact.
    expect(gaussQuad((x) => x ** 6, 0, 1, 3)).not.toBeCloseTo(1 / 7, 14);
    expect(gaussQuad((x) => x ** 6, 0, 1, 4)).toBeCloseTo(1 / 7, 14);
  });

  it("handles a reversed interval by antisymmetry", () => {
    expect(gaussQuad((x) => x, 1, 0, 5)).toBeCloseTo(-0.5, 14);
  });
});

describe("adaptive quadrature", () => {
  it("nails smooth integrands with a tiny error estimate", () => {
    const q = adaptiveQuad(Math.sin, 0, Math.PI);
    expect(q.value).toBeCloseTo(2, 12);
    expect(q.error).toBeLessThan(1e-10);
  });

  it("reports a real error estimate that bounds the real error", () => {
    // A peaked integrand: ∫₋₁¹ 1/(1 + 400x²) dx = atan(20)/10.
    const exact = Math.atan(20) / 10;
    const q = adaptiveQuad((x) => 1 / (1 + 400 * sq(x)), -1, 1, { tol: 1e-9 });
    expect(q.value).toBeCloseTo(exact, 9);
    expect(Math.abs(q.value - exact)).toBeLessThanOrEqual(
      Math.max(q.error, 1e-12) * 50,
    );
  });

  it("refining drives the error down", () => {
    const f = (x: number) => Math.exp(Math.sin(5 * x));
    const loose = adaptiveQuad(f, 0, 3, { tol: 1e-4 });
    const tight = adaptiveQuad(f, 0, 3, { tol: 1e-12 });
    expect(tight.error).toBeLessThan(loose.error);
    expect(tight.evals).toBeGreaterThan(loose.evals);
    expect(tight.value).toBeCloseTo(loose.value, 4);
  });

  it("integrates piecewise without straddling a corner", () => {
    // |x| on [-1,1] has a corner at 0; a panel across it converges badly.
    const withBreak = piecewiseQuad(Math.abs, [-1, 0, 1]);
    expect(withBreak.value).toBeCloseTo(1, 13);
    expect(withBreak.error).toBeLessThan(1e-12);
  });

  it("returns zero for a degenerate interval", () => {
    expect(adaptiveQuad(Math.sin, 1, 1).value).toBe(0);
  });
});

describe("polygon geometry", () => {
  const square: Pt[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it("signs area by orientation", () => {
    expect(signedArea(square)).toBeCloseTo(1, 14);
    expect(signedArea([...square].reverse())).toBeCloseTo(-1, 14);
  });

  it("drops duplicate and closing points", () => {
    expect(dedupe([...square, { x: 0, y: 0 }])).toHaveLength(4);
    expect(dedupe([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toHaveLength(1);
  });

  it("detects a self-crossing loop", () => {
    expect(selfIntersects(square)).toBe(false);
    // A bowtie: the classic dragged-across-itself case.
    const bowtie: Pt[] = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
    ];
    expect(selfIntersects(bowtie)).toBe(true);
  });

  it("triangulates convex and concave polygons, conserving area", () => {
    const check = (pts: Pt[]) => {
      const tris = triangulate(pts);
      expect(tris).not.toBeNull();
      const total = tris!.reduce(
        (s, t) =>
          s + Math.abs((t.b.x - t.a.x) * (t.c.y - t.a.y) - (t.b.y - t.a.y) * (t.c.x - t.a.x)) / 2,
        0,
      );
      expect(total).toBeCloseTo(Math.abs(signedArea(pts)), 10);
      expect(tris!).toHaveLength(pts.length - 2);
    };
    check(square);
    check([...square].reverse());
    // An L: concave, so a naive fan triangulation would leak outside it.
    check([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 3 },
      { x: 0, y: 3 },
    ]);
  });

  it("refuses degenerate input", () => {
    expect(triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(triangulate([])).toBeNull();
  });
});

describe("area integration", () => {
  it("integrates over a triangle exactly for low-degree polynomials", () => {
    const ref = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 } };
    expect(triangleIntegral(() => 1, ref)).toBeCloseTo(0.5, 12);
    expect(triangleIntegral((x) => x, ref)).toBeCloseTo(1 / 6, 12);
    expect(triangleIntegral((x, y) => x * y, ref)).toBeCloseTo(1 / 24, 12);
    expect(triangleIntegral((x) => x * x, ref)).toBeCloseTo(1 / 12, 12);
  });

  it("integrates over a polygon and respects orientation", () => {
    const square: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const q = polygonIntegral((x, y) => x * y, square)!;
    expect(q.value).toBeCloseTo(0.25, 11);
    expect(q.error).toBeLessThan(1e-9);
    const flipped = polygonIntegral((x, y) => x * y, [...square].reverse())!;
    expect(flipped.value).toBeCloseTo(-0.25, 11);
  });

  it("returns null for a polygon it cannot triangulate", () => {
    expect(polygonIntegral(() => 1, [{ x: 0, y: 0 }])).toBeNull();
  });

  it("integrates over a rectangle by tensor Gauss", () => {
    const q = rectIntegral((x, y) => x * x * y, 0, 0, 2, 3);
    expect(q.value).toBeCloseTo((8 / 3) * (9 / 2), 10);
    expect(q.error).toBeLessThan(1e-9);
  });

  it("integrates over a disk with exact geometry", () => {
    const area = diskIntegral(() => 1, 0, 0, 1);
    expect(area.value).toBeCloseTo(Math.PI, 10);
    // ∬_disk x² dA = π/4
    expect(diskIntegral((x) => x * x, 0, 0, 1).value).toBeCloseTo(Math.PI / 4, 9);
    // ∬ over a shifted disk of radius 2: area 4π
    expect(diskIntegral(() => 1, 3, -1, 2).value).toBeCloseTo(4 * Math.PI, 9);
    // A polygonized disk approaches the same number, but strictly from below —
    // an inscribed n-gon has area (n/2)·sin(2π/n) < π. That gap is geometry
    // error, not quadrature error, which is why a disk region uses the polar
    // rule rather than being polygonized.
    const ngon = (n: number): Pt[] =>
      Array.from({ length: n }, (_, i) => {
        const t = (2 * Math.PI * i) / n;
        return { x: Math.cos(t), y: Math.sin(t) };
      });
    const coarse = polygonIntegral(() => 1, ngon(64))!.value;
    const fine = polygonIntegral(() => 1, ngon(256))!.value;
    expect(fine).toBeCloseTo((256 / 2) * Math.sin((2 * Math.PI) / 256), 10);
    expect(fine).toBeLessThan(Math.PI);
    expect(fine).toBeGreaterThan(coarse);
    expect(fine).toBeCloseTo(Math.PI, 3);
  });
});
