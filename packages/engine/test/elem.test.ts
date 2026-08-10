import { describe, expect, it } from "vitest";
import * as D from "../src/dual";
import {
  ElemError,
  evalAt,
  evalDual,
  isConstantIn,
  PARAM_OPTS,
  parse,
  refs,
  toPoly,
  tryParse,
} from "../src/elem";
import { constValue, toText } from "../src/poly";

const at = (src: string, x: number, y: number, z = 0) =>
  evalAt(parse(src), x, y, z);

const grad = (src: string, x: number, y: number, z = 0) => {
  const d = evalDual(parse(src), x, y, z);
  return { v: d.v, dx: d.dx, dy: d.dy, dz: d.dz };
};

/** Central difference, used ONLY to check the AD against something independent. */
function numericGrad(src: string, x: number, y: number) {
  const h = 1e-6;
  const f = (a: number, b: number) => at(src, a, b);
  return {
    dx: (f(x + h, y) - f(x - h, y)) / (2 * h),
    dy: (f(x, y + h) - f(x, y - h)) / (2 * h),
  };
}

describe("parsing", () => {
  it("handles arithmetic, precedence, and implicit products", () => {
    expect(at("2 + 3 * 4", 0, 0)).toBe(14);
    expect(at("2x", 3, 0)).toBe(6);
    expect(at("2x^3", 2, 0)).toBe(16); // 2·(2³), not (2·2)³
    expect(at("(1 + 2)(3 + 4)", 0, 0)).toBe(21);
    expect(at("-x^2", 3, 0)).toBe(-9);
    expect(at("2^3^2", 0, 0)).toBe(512); // right-associative
  });

  it("supports division, which the Poly ring cannot", () => {
    expect(at("1/x", 4, 0)).toBe(0.25);
    expect(at("x/y", 6, 3)).toBe(2);
    expect(at("6 ÷ 3", 0, 0)).toBe(2);
  });

  it("knows the elementary functions and constants", () => {
    expect(at("sin(0)", 0, 0)).toBe(0);
    expect(at("cos(pi)", 0, 0)).toBeCloseTo(-1, 12);
    expect(at("exp(0)", 0, 0)).toBe(1);
    expect(at("ln(e)", 0, 0)).toBeCloseTo(1, 12);
    expect(at("sqrt(9)", 0, 0)).toBe(3);
    expect(at("hypot(3, 4)", 0, 0)).toBe(5);
    expect(at("atan2(1, 1)", 0, 0)).toBeCloseTo(Math.PI / 4, 12);
    expect(at("abs(0 - 3)", 0, 0)).toBe(3);
  });

  it("desugars the polar names", () => {
    expect(at("r", 3, 4)).toBe(5);
    expect(at("theta", 0, 1)).toBeCloseTo(Math.PI / 2, 12);
    expect(at("th", 1, 1)).toBeCloseTo(Math.PI / 4, 12);
  });

  it("binds a single parameter for curve parameterizations", () => {
    // A curve's x(t) sees `t`, not x/y — and polar sugar is off, so `r` inside
    // a parameterization is an unbound name rather than silently meaning √(t²).
    const opts = PARAM_OPTS("t");
    const node = parse("2·cos(t)", opts);
    expect(evalAt(node, 0, 0)).toBeCloseTo(2, 12);
    expect(evalAt(node, Math.PI, 0)).toBeCloseTo(-2, 12);
    // x and y are no longer coordinates here; they'd be unbound references.
    expect(() => evalAt(parse("x", opts), 1, 2)).toThrow(/Unknown name "x"/);
    expect(() => evalAt(parse("r", opts), 1, 2)).toThrow(/Unknown name "r"/);
    // A different parameter name works too.
    expect(evalAt(parse("s^2", PARAM_OPTS("s")), 3, 0)).toBe(9);
  });

  it("leaves the default parse behaviour untouched", () => {
    // The options are additive: no opts means exactly what it always meant.
    expect(at("r", 3, 4)).toBe(5);
    expect(evalAt(parse("x + y"), 1, 2)).toBe(3);
  });

  it("reports bad input rather than guessing", () => {
    expect(() => parse("sin")).toThrow(ElemError);
    expect(() => parse("hypot(1)")).toThrow(/expects 2 arguments/);
    expect(() => parse("(1 + 2")).toThrow(/Missing \)/);
    expect(() => parse("1 $ 2")).toThrow(/Unexpected character/);
    expect(() => parse("")).toThrow(ElemError);
    expect(tryParse("1 +")).toBeNull();
    expect(tryParse("2x")).not.toBeNull();
  });

  it("throws on an unbound reference instead of silently reading zero", () => {
    // Warp's matrix cells fall back to 0 here, which cost a lesson redesign.
    // Flux surfaces it.
    expect(() => evalAt(parse("a·y"), 1, 1)).toThrow(/Unknown name "a"/);
    expect(evalAt(parse("a·y"), 1, 2, 0, new Map([["a", 3]]))).toBe(6);
  });

  it("tracks references and coordinate dependence", () => {
    expect([...refs(parse("a·x + b"))].sort()).toEqual(["a", "b"]);
    expect(isConstantIn(parse("2 + a"))).toBe(true);
    expect(isConstantIn(parse("2 + x"))).toBe(false);
    expect(isConstantIn(parse("sin(a)"))).toBe(true);
  });
});

describe("automatic differentiation", () => {
  it("matches finite differences on a spread of expressions", () => {
    const cases = [
      "x^2 + y^2",
      "x·y",
      "sin(x)·cos(y)",
      "exp(x·y)",
      "1/(x^2 + y^2)",
      "sqrt(x^2 + y^2)",
      "atan2(y, x)",
      "x^3·y - y^3·x",
      "tanh(x + y)",
      "ln(x^2 + y^2)",
    ];
    for (const src of cases) {
      const ad = grad(src, 1.3, -0.7);
      const fd = numericGrad(src, 1.3, -0.7);
      expect(ad.dx).toBeCloseTo(fd.dx, 6);
      expect(ad.dy).toBeCloseTo(fd.dy, 6);
    }
  });

  it("gets the partials of the polar angle exactly right", () => {
    // ∂θ/∂x = −y/r², ∂θ/∂y = x/r². This is *why* (−y, x)/r² is curl-free:
    // it is ∇θ, a gradient — on any domain where θ can be defined at all.
    const x = 2;
    const y = 3;
    const r2 = x * x + y * y;
    const d = grad("theta", x, y);
    expect(d.dx).toBeCloseTo(-y / r2, 12);
    expect(d.dy).toBeCloseTo(x / r2, 12);
  });

  it("keeps negative bases working under the power rule", () => {
    // exp(b·ln a) would produce NaN here; the constant-exponent path must not.
    expect(at("x^3", -2, 0)).toBe(-8);
    expect(grad("x^3", -2, 0).dx).toBeCloseTo(12, 12);
  });

  it("reports a singularity as non-finite rather than a large number", () => {
    const d = evalDual(parse("1/(x^2 + y^2)"), 0, 0);
    expect(Number.isFinite(d.v)).toBe(false);
    expect(D.isFinite_(d)).toBe(false);
  });
});

describe("the bridge back to the polynomial ring", () => {
  const text = (src: string, scope?: Map<string, number>) => {
    const p = toPoly(parse(src), scope);
    return p === null ? null : toText(p, (n) => String(Math.round(n * 1e6) / 1e6));
  };

  it("converts polynomials exactly", () => {
    expect(text("2x^3 + 3x·y^2")).toBe("2x³ + 3xy²");
    expect(text("(x + y)^2")).toBe("x² + 2xy + y²");
    expect(text("x - x")).toBe("0");
    expect(text("x/2")).toBe("0.5x");
  });

  it("folds slider values in as coefficients", () => {
    expect(text("a·y", new Map([["a", 3]]))).toBe("3y");
    expect(text("a·y")).toBeNull(); // unbound → not convertible
  });

  it("refuses everything that leaves the ring", () => {
    expect(text("1/x")).toBeNull();
    expect(text("x/y")).toBeNull();
    expect(text("sin(x)")).toBeNull();
    expect(text("sqrt(x)")).toBeNull();
    expect(text("x^0.5")).toBeNull();
    expect(text("x^(0 - 1)")).toBeNull();
    expect(text("r")).toBeNull();
    expect(text("x/0")).toBeNull();
  });

  it("agrees with the dual-number path where both apply", () => {
    const src = "3x^2·y - 2y^3 + 5";
    const node = parse(src);
    const p = toPoly(node)!;
    expect(p).not.toBeNull();
    // Same value two ways: Poly evaluation via diff-free substitution, and duals.
    const x = 1.7;
    const y = -0.4;
    const viaDual = evalAt(node, x, y);
    let viaPoly = 0;
    for (const [k, c] of p) {
      const [ex, ey, ez] = k.split(",").map(Number);
      viaPoly += c * Math.pow(x, ex) * Math.pow(y, ey) * Math.pow(0, ez === 0 ? 0 : ez);
    }
    expect(viaPoly).toBeCloseTo(viaDual, 10);
  });

  it("keeps a constant polynomial readable", () => {
    expect(constValue(toPoly(parse("2 + 3"))!)).toBe(5);
  });
});
