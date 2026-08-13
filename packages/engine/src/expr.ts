/**
 * A tiny expression engine for Warp's sandbox.
 *
 * It parses and evaluates expressions over a typed algebra of scalars,
 * 2D/3D vectors, and 2x2/3x3 matrices. Every scalar slot is a polynomial in
 * the symbols x, y, z (see poly.ts) — a plain number is just a constant
 * polynomial — so symbolic values like (2x, 3y) flow through +, −, ×, dot,
 * cross, det, and transpose by the ordinary rules of algebra. Operations
 * that genuinely need numbers (inv, norm, eigen, projecting onto w) say so.
 *
 * Supported syntax:
 *   + - * (and the · glyph), ^ powers, unary minus, parentheses,
 *   vector literals (a, b) / (a, b, c), function calls (det, eigen, inv,
 *   transpose, dot, cross, norm, proj), and variable references.
 *   Juxtaposition means multiplication: "2v", "2(v + w)", "xy" = x·y.
 *
 * Like everything in lib/, this is pure and rendering-agnostic.
 */

import { inverse, type Mat2, type Vec2 } from "./matrix";
import { inverse3, type Mat3, type Vec3 } from "./matrix3";
import * as P from "./poly";
import { type Poly } from "./poly";

// Symbolic containers: same shapes as matrix.ts/matrix3.ts, but every slot
// is a polynomial instead of a number.
export interface PVec2 {
  x: Poly;
  y: Poly;
}
export interface PVec3 {
  x: Poly;
  y: Poly;
  z: Poly;
}
export type PMat2 = readonly [Poly, Poly, Poly, Poly];
export type PMat3 = readonly [
  Poly, Poly, Poly,
  Poly, Poly, Poly,
  Poly, Poly, Poly,
];

export type Value =
  | { kind: "scalar"; value: Poly }
  | { kind: "vector"; value: PVec2 }
  | { kind: "matrix"; value: PMat2 }
  | { kind: "vector3"; value: PVec3 }
  | { kind: "matrix3"; value: PMat3 }
  // The del operator ∇ — only meaningful inside dot(del, F) (divergence)
  // and cross(del, F) (curl); everywhere else it's a typed error.
  | { kind: "del" };

/** Human-readable name of a value's type, for error messages. */
export function kindName(k: Value["kind"]): string {
  switch (k) {
    case "scalar":
      return "number";
    case "vector":
      return "2D vector";
    case "matrix":
      return "2×2 matrix";
    case "vector3":
      return "3D vector";
    case "matrix3":
      return "3×3 matrix";
    case "del":
      return "del operator";
  }
}

export type Env = Map<string, Value>;

export class ExprError extends Error {}

// --- Numeric <-> symbolic boundary helpers. App code builds env entries
// --- from numeric rows and converts results back for graphing; a null
// --- conversion means "contains x/y/z" and therefore doesn't graph. --------

export const constScalar = (n: number): Value => ({
  kind: "scalar",
  value: P.constant(n),
});
export const constVec2 = (v: Vec2): Value => ({
  kind: "vector",
  value: { x: P.constant(v.x), y: P.constant(v.y) },
});
export const constVec3 = (v: Vec3): Value => ({
  kind: "vector3",
  value: { x: P.constant(v.x), y: P.constant(v.y), z: P.constant(v.z) },
});
export const constMat2 = (m: Mat2): Value => ({
  kind: "matrix",
  value: m.map(P.constant) as unknown as PMat2,
});
export const constMat3 = (m: Mat3): Value => ({
  kind: "matrix3",
  value: m.map(P.constant) as unknown as PMat3,
});

export function numScalar(p: Poly): number | null {
  return P.isConst(p) ? P.constValue(p) : null;
}
export function numVec2(v: PVec2): Vec2 | null {
  const x = numScalar(v.x);
  const y = numScalar(v.y);
  return x !== null && y !== null ? { x, y } : null;
}
export function numVec3(v: PVec3): Vec3 | null {
  const x = numScalar(v.x);
  const y = numScalar(v.y);
  const z = numScalar(v.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}
export function numMat2(m: PMat2): Mat2 | null {
  const out = m.map(numScalar);
  return out.every((n) => n !== null) ? (out as unknown as Mat2) : null;
}
export function numMat3(m: PMat3): Mat3 | null {
  const out = m.map(numScalar);
  return out.every((n) => n !== null) ? (out as unknown as Mat3) : null;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "^" }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isAlpha = (c: string) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (c === "(") {
      toks.push({ t: "lp" });
      i++;
    } else if (c === ")") {
      toks.push({ t: "rp" });
      i++;
    } else if (c === ",") {
      toks.push({ t: "comma" });
      i++;
    } else if (c === "+" || c === "-" || c === "^") {
      toks.push({ t: "op", v: c });
      i++;
    } else if (c === "*" || c === "·" || c === "×" || c === "•") {
      toks.push({ t: "op", v: "*" });
      i++;
    } else if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && (isDigit(src[j]) || src[j] === ".")) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
    } else if (isAlpha(c)) {
      let j = i;
      while (j < src.length && (isAlpha(src[j]) || isDigit(src[j]))) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else {
      throw new ExprError(`Unexpected character "${c}"`);
    }
  }
  return toks;
}

// ---------------------------------------------------------------------------
// AST + parser (recursive descent)
// ---------------------------------------------------------------------------

/**
 * Built-in functions and the argument counts each accepts. Most take a fixed
 * number; `diag` takes 2 in the plane and 3 in space.
 */
const FN_ARITY = {
  det: [1],
  eigen: [1],
  svd: [1],
  inv: [1],
  transpose: [1],
  norm: [1],
  dot: [2],
  cross: [2],
  proj: [2],
  // Shape primitives: they take nothing and draw the unit circle / sphere,
  // which the active matrix then carries onto an ellipse / ellipsoid.
  circle: [0],
  sphere: [0],
  // A stretch along the axes and nothing else. Worth having as a builtin
  // rather than four editable cells: it can be driven by sliders (matrix cells
  // can't reference other rows), and it cannot accidentally stop being
  // diagonal, so "this is a pure stretch" stays true while the reader plays.
  diag: [2, 3],
} as const;

/** "det expects 1 argument", "diag expects 2 or 3 arguments". */
function arityError(fn: string, want: readonly number[]): ExprError {
  const list =
    want.length === 1
      ? String(want[0])
      : want.slice(0, -1).join(", ") + " or " + want[want.length - 1];
  const plural = want.length === 1 && want[0] === 1 ? "argument" : "arguments";
  return new ExprError(`${fn} expects ${list} ${plural}`);
}
export type FnName = keyof typeof FN_ARITY;

export type Node =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "vec"; x: Node; y: Node }
  | { t: "vec3"; x: Node; y: Node; z: Node }
  | { t: "neg"; a: Node }
  | { t: "add"; a: Node; b: Node }
  | { t: "sub"; a: Node; b: Node }
  | { t: "mul"; a: Node; b: Node }
  | { t: "pow"; a: Node; b: Node }
  | { t: "call"; fn: FnName; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  parse(): Node {
    const node = this.parseExpr();
    if (this.pos < this.toks.length) throw new ExprError("Unexpected trailing input");
    return node;
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(): Node {
    let node = this.parseTerm();
    while (true) {
      const p = this.peek();
      if (p?.t === "op" && (p.v === "+" || p.v === "-")) {
        this.next();
        const rhs = this.parseTerm();
        node = { t: p.v === "+" ? "add" : "sub", a: node, b: rhs };
      } else break;
    }
    return node;
  }

  // term := factor ( ('*')? factor )*   — juxtaposition is multiplication
  private parseTerm(): Node {
    let node = this.parseFactor();
    while (true) {
      const p = this.peek();
      if (p?.t === "op" && p.v === "*") {
        this.next();
        node = { t: "mul", a: node, b: this.parseFactor() };
      } else if (p && (p.t === "num" || p.t === "id" || p.t === "lp")) {
        // implicit multiplication, e.g. 2v
        node = { t: "mul", a: node, b: this.parseFactor() };
      } else break;
    }
    return node;
  }

  // factor := '-' factor | power
  private parseFactor(): Node {
    const p = this.peek();
    if (p?.t === "op" && p.v === "-") {
      this.next();
      return { t: "neg", a: this.parseFactor() };
    }
    if (p?.t === "op" && p.v === "+") {
      this.next();
      return this.parseFactor();
    }
    return this.parsePower();
  }

  // power := atom ('^' factor)?  — binds tighter than juxtaposition,
  // so "2x^3" is 2·(x³); right recursion makes "x^2^3" x^(2³).
  private parsePower(): Node {
    const base = this.parseAtom();
    const p = this.peek();
    if (p?.t === "op" && p.v === "^") {
      this.next();
      return { t: "pow", a: base, b: this.parseFactor() };
    }
    return base;
  }

  private parseAtom(): Node {
    const tok = this.next();
    if (!tok) throw new ExprError("Unexpected end of expression");
    if (tok.t === "num") return { t: "num", v: tok.v };
    if (tok.t === "id") {
      if (tok.v in FN_ARITY) {
        const fn = tok.v as FnName;
        if (this.peek()?.t !== "lp")
          throw new ExprError(`${fn} expects parentheses`);
        this.next(); // (
        // "circle()" — an empty argument list is legal for the zero-arity
        // shape primitives, and caught by the arity check otherwise.
        const args: Node[] = [];
        if (this.peek()?.t !== "rp") {
          args.push(this.parseExpr());
          while (this.peek()?.t === "comma") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        if (this.next()?.t !== "rp") throw new ExprError("Missing )");
        const want = FN_ARITY[fn] as readonly number[];
        if (!want.includes(args.length)) throw arityError(fn, want);
        return { t: "call", fn, args };
      }
      return { t: "var", name: tok.v };
    }
    if (tok.t === "lp") {
      const first = this.parseExpr();
      const p = this.peek();
      if (p?.t === "comma") {
        this.next();
        const second = this.parseExpr();
        if (this.peek()?.t === "comma") {
          this.next();
          const third = this.parseExpr();
          if (this.next()?.t !== "rp") throw new ExprError("Missing )");
          return { t: "vec3", x: first, y: second, z: third };
        }
        if (this.next()?.t !== "rp") throw new ExprError("Missing )");
        return { t: "vec", x: first, y: second };
      }
      if (this.next()?.t !== "rp") throw new ExprError("Missing )");
      return first;
    }
    throw new ExprError("Unexpected token");
  }
}

export function parse(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const scalar = (p: Poly): Value => ({ kind: "scalar", value: p });
const vector = (v: PVec2): Value => ({ kind: "vector", value: v });
const matrix = (m: PMat2): Value => ({ kind: "matrix", value: m });
const vector3 = (v: PVec3): Value => ({ kind: "vector3", value: v });
const matrix3 = (m: PMat3): Value => ({ kind: "matrix3", value: m });

function add(a: Value, b: Value, sign: 1 | -1): Value {
  const s = sign;
  if (a.kind === "scalar" && b.kind === "scalar")
    return scalar(P.add(a.value, b.value, s));
  if (a.kind === "vector" && b.kind === "vector")
    return vector({
      x: P.add(a.value.x, b.value.x, s),
      y: P.add(a.value.y, b.value.y, s),
    });
  if (a.kind === "vector3" && b.kind === "vector3")
    return vector3({
      x: P.add(a.value.x, b.value.x, s),
      y: P.add(a.value.y, b.value.y, s),
      z: P.add(a.value.z, b.value.z, s),
    });
  if (a.kind === "matrix" && b.kind === "matrix") {
    const bv = b.value;
    return matrix(a.value.map((p, i) => P.add(p, bv[i], s)) as unknown as PMat2);
  }
  if (a.kind === "matrix3" && b.kind === "matrix3") {
    const bv = b.value;
    return matrix3(a.value.map((p, i) => P.add(p, bv[i], s)) as unknown as PMat3);
  }
  const word = s === 1 ? "add" : "subtract";
  throw new ExprError(
    `Can't ${word} a ${kindName(a.kind)} and a ${kindName(b.kind)}`,
  );
}

function mul(a: Value, b: Value): Value {
  if (a.kind === "scalar" && b.kind === "scalar")
    return scalar(P.mul(a.value, b.value));
  if (a.kind === "scalar" && b.kind === "vector")
    return vector({ x: P.mul(a.value, b.value.x), y: P.mul(a.value, b.value.y) });
  if (a.kind === "vector" && b.kind === "scalar") return mul(b, a);
  if (a.kind === "scalar" && b.kind === "vector3")
    return vector3({
      x: P.mul(a.value, b.value.x),
      y: P.mul(a.value, b.value.y),
      z: P.mul(a.value, b.value.z),
    });
  if (a.kind === "vector3" && b.kind === "scalar") return mul(b, a);
  if (a.kind === "scalar" && b.kind === "matrix") {
    const s = a.value;
    return matrix(b.value.map((p) => P.mul(s, p)) as unknown as PMat2);
  }
  if (a.kind === "matrix" && b.kind === "scalar") return mul(b, a);
  if (a.kind === "scalar" && b.kind === "matrix3") {
    const s = a.value;
    return matrix3(b.value.map((p) => P.mul(s, p)) as unknown as PMat3);
  }
  if (a.kind === "matrix3" && b.kind === "scalar") return mul(b, a);
  if (a.kind === "matrix" && b.kind === "vector") {
    const m = a.value;
    const v = b.value;
    return vector({
      x: P.add(P.mul(m[0], v.x), P.mul(m[1], v.y)),
      y: P.add(P.mul(m[2], v.x), P.mul(m[3], v.y)),
    });
  }
  if (a.kind === "matrix3" && b.kind === "vector3") {
    const m = a.value;
    const v = b.value;
    const row = (r: number) =>
      P.add(P.add(P.mul(m[r], v.x), P.mul(m[r + 1], v.y)), P.mul(m[r + 2], v.z));
    return vector3({ x: row(0), y: row(3), z: row(6) });
  }
  if (a.kind === "matrix" && b.kind === "matrix") {
    const m = a.value;
    const n = b.value;
    return matrix([
      P.add(P.mul(m[0], n[0]), P.mul(m[1], n[2])),
      P.add(P.mul(m[0], n[1]), P.mul(m[1], n[3])),
      P.add(P.mul(m[2], n[0]), P.mul(m[3], n[2])),
      P.add(P.mul(m[2], n[1]), P.mul(m[3], n[3])),
    ]);
  }
  if (a.kind === "matrix3" && b.kind === "matrix3") {
    const m = a.value;
    const n = b.value;
    const out: Poly[] = new Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = P.add(
          P.add(P.mul(m[r * 3], n[c]), P.mul(m[r * 3 + 1], n[3 + c])),
          P.mul(m[r * 3 + 2], n[6 + c]),
        );
    return matrix3(out as unknown as PMat3);
  }
  if (
    (a.kind === "vector" && b.kind === "matrix") ||
    (a.kind === "vector3" && b.kind === "matrix3")
  )
    throw new ExprError("Put the matrix on the left of the vector (M·v)");
  throw new ExprError(
    `Can't multiply a ${kindName(a.kind)} and a ${kindName(b.kind)}`,
  );
}

const SYMBOLS: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** A name is either bound in the env, a symbol x/y/z, or the del operator. */
function resolveName(name: string, env: Env): Value | null {
  const v = env.get(name);
  if (v) return v;
  if (name in SYMBOLS) return scalar(P.symbol(SYMBOLS[name]));
  if (name === "del") return { kind: "del" };
  return null;
}

export function evaluate(node: Node, env: Env): Value {
  switch (node.t) {
    case "num":
      return constScalar(node.v);
    case "var": {
      const v = resolveName(node.name, env);
      if (v) return v;
      // Desmos-style implicit product: an unknown all-letter identifier
      // like "xy" or "ax" splits into single letters if every one resolves.
      if (node.name.length > 1 && /^[A-Za-z]+$/.test(node.name)) {
        let acc: Value | null = null;
        for (const ch of node.name) {
          const cv = resolveName(ch, env);
          if (!cv) {
            acc = null;
            break;
          }
          acc = acc === null ? cv : mul(acc, cv);
        }
        if (acc) return acc;
      }
      throw new ExprError(`"${node.name}" is not defined`);
    }
    case "vec": {
      const x = evaluate(node.x, env);
      const y = evaluate(node.y, env);
      if (x.kind !== "scalar" || y.kind !== "scalar")
        throw new ExprError("Vector components must be numbers");
      return vector({ x: x.value, y: y.value });
    }
    case "vec3": {
      const x = evaluate(node.x, env);
      const y = evaluate(node.y, env);
      const z = evaluate(node.z, env);
      if (x.kind !== "scalar" || y.kind !== "scalar" || z.kind !== "scalar")
        throw new ExprError("Vector components must be numbers");
      return vector3({ x: x.value, y: y.value, z: z.value });
    }
    case "neg":
      return mul(constScalar(-1), evaluate(node.a, env));
    case "add":
      return add(evaluate(node.a, env), evaluate(node.b, env), 1);
    case "sub":
      return add(evaluate(node.a, env), evaluate(node.b, env), -1);
    case "mul":
      return mul(evaluate(node.a, env), evaluate(node.b, env));
    case "pow": {
      const base = evaluate(node.a, env);
      const expo = evaluate(node.b, env);
      if (base.kind !== "scalar" || expo.kind !== "scalar")
        throw new ExprError("^ expects numbers");
      const n = numScalar(expo.value);
      if (n === null) throw new ExprError("Exponents can't contain x, y, z");
      const bc = numScalar(base.value);
      if (bc !== null) {
        const r = Math.pow(bc, n);
        if (!Number.isFinite(r)) throw new ExprError("Invalid power");
        return constScalar(r);
      }
      if (!Number.isInteger(n) || n < 0)
        throw new ExprError("Symbolic powers need a whole-number exponent");
      if (n > 32) throw new ExprError("Exponent too large");
      return scalar(P.pow(base.value, n));
    }
    case "call": {
      const args = node.args.map((n) => evaluate(n, env));
      switch (node.fn) {
        case "det": {
          const [a] = args;
          if (a.kind === "matrix") {
            const m = a.value;
            return scalar(P.add(P.mul(m[0], m[3]), P.mul(m[1], m[2]), -1));
          }
          if (a.kind === "matrix3") {
            const m = a.value;
            const minor = (p: Poly, q: Poly, r: Poly, s: Poly) =>
              P.add(P.mul(p, s), P.mul(q, r), -1);
            let d = P.mul(m[0], minor(m[4], m[5], m[7], m[8]));
            d = P.add(d, P.mul(m[1], minor(m[3], m[5], m[6], m[8])), -1);
            d = P.add(d, P.mul(m[2], minor(m[3], m[4], m[6], m[7])));
            return scalar(d);
          }
          throw new ExprError("det expects a matrix");
        }
        case "inv": {
          const [a] = args;
          if (a.kind === "matrix") {
            const m = numMat2(a.value);
            if (!m) throw new ExprError("inv needs numeric entries");
            const r = inverse(m);
            if (!r) throw new ExprError("Not invertible (det = 0)");
            return constMat2(r);
          }
          if (a.kind === "matrix3") {
            const m = numMat3(a.value);
            if (!m) throw new ExprError("inv needs numeric entries");
            const r = inverse3(m);
            if (!r) throw new ExprError("Not invertible (det = 0)");
            return constMat3(r);
          }
          throw new ExprError("inv expects a matrix");
        }
        case "transpose": {
          const [a] = args;
          if (a.kind === "matrix") {
            const m = a.value;
            return matrix([m[0], m[2], m[1], m[3]]);
          }
          if (a.kind === "matrix3") {
            const m = a.value;
            return matrix3([
              m[0], m[3], m[6],
              m[1], m[4], m[7],
              m[2], m[5], m[8],
            ]);
          }
          throw new ExprError("transpose expects a matrix");
        }
        case "norm": {
          const [a] = args;
          if (a.kind === "vector") {
            const v = numVec2(a.value);
            if (!v) throw new ExprError("norm needs numeric components");
            return constScalar(Math.hypot(v.x, v.y));
          }
          if (a.kind === "vector3") {
            const v = numVec3(a.value);
            if (!v) throw new ExprError("norm needs numeric components");
            return constScalar(Math.hypot(v.x, v.y, v.z));
          }
          throw new ExprError("norm expects a vector");
        }
        case "dot": {
          const [a, b] = args;
          if (a.kind === "del") {
            // Divergence: ∇·F = ∂F₁/∂x + ∂F₂/∂y (+ ∂F₃/∂z).
            if (b.kind === "vector")
              return scalar(P.add(P.diff(b.value.x, 0), P.diff(b.value.y, 1)));
            if (b.kind === "vector3")
              return scalar(
                P.add(
                  P.add(P.diff(b.value.x, 0), P.diff(b.value.y, 1)),
                  P.diff(b.value.z, 2),
                ),
              );
            throw new ExprError("dot(del, F) expects a vector field F");
          }
          if (b.kind === "del")
            throw new ExprError("Put del first: dot(del, F)");
          if (a.kind === "vector" && b.kind === "vector")
            return scalar(
              P.add(P.mul(a.value.x, b.value.x), P.mul(a.value.y, b.value.y)),
            );
          if (a.kind === "vector3" && b.kind === "vector3")
            return scalar(
              P.add(
                P.add(
                  P.mul(a.value.x, b.value.x),
                  P.mul(a.value.y, b.value.y),
                ),
                P.mul(a.value.z, b.value.z),
              ),
            );
          throw new ExprError("dot expects two vectors of the same dimension");
        }
        case "cross": {
          const [a, b] = args;
          if (a.kind === "del") {
            // Curl: in 2D the scalar ∂F₂/∂x − ∂F₁/∂y; in 3D the full ∇×F.
            if (b.kind === "vector")
              return scalar(
                P.add(P.diff(b.value.y, 0), P.diff(b.value.x, 1), -1),
              );
            if (b.kind === "vector3") {
              const F = b.value;
              return vector3({
                x: P.add(P.diff(F.z, 1), P.diff(F.y, 2), -1),
                y: P.add(P.diff(F.x, 2), P.diff(F.z, 0), -1),
                z: P.add(P.diff(F.y, 0), P.diff(F.x, 1), -1),
              });
            }
            throw new ExprError("cross(del, F) expects a vector field F");
          }
          if (b.kind === "del")
            throw new ExprError("Put del first: cross(del, F)");
          if (a.kind === "vector" && b.kind === "vector")
            // 2D cross: the scalar v.x·w.y − v.y·w.x (the signed area of the
            // parallelogram; equivalently det([v w])).
            return scalar(
              P.add(P.mul(a.value.x, b.value.y), P.mul(a.value.y, b.value.x), -1),
            );
          if (a.kind === "vector3" && b.kind === "vector3") {
            const u = a.value;
            const v = b.value;
            return vector3({
              x: P.add(P.mul(u.y, v.z), P.mul(u.z, v.y), -1),
              y: P.add(P.mul(u.z, v.x), P.mul(u.x, v.z), -1),
              z: P.add(P.mul(u.x, v.y), P.mul(u.y, v.x), -1),
            });
          }
          throw new ExprError("cross expects two vectors of the same dimension");
        }
        case "proj": {
          // proj(v, w): the projection of v onto w. The direction w must be
          // numeric (division); v may be symbolic.
          const [a, b] = args;
          if (a.kind === "vector" && b.kind === "vector") {
            const w = numVec2(b.value);
            if (!w)
              throw new ExprError("proj needs numeric components in w");
            const ww = w.x * w.x + w.y * w.y;
            if (ww < 1e-24)
              throw new ExprError("Can't project onto the zero vector");
            const k = P.scale(
              P.add(P.scale(a.value.x, w.x), P.scale(a.value.y, w.y)),
              1 / ww,
            );
            return vector({ x: P.scale(k, w.x), y: P.scale(k, w.y) });
          }
          if (a.kind === "vector3" && b.kind === "vector3") {
            const w = numVec3(b.value);
            if (!w)
              throw new ExprError("proj needs numeric components in w");
            const ww = w.x * w.x + w.y * w.y + w.z * w.z;
            if (ww < 1e-24)
              throw new ExprError("Can't project onto the zero vector");
            const k = P.scale(
              P.add(
                P.add(P.scale(a.value.x, w.x), P.scale(a.value.y, w.y)),
                P.scale(a.value.z, w.z),
              ),
              1 / ww,
            );
            return vector3({
              x: P.scale(k, w.x),
              y: P.scale(k, w.y),
              z: P.scale(k, w.z),
            });
          }
          throw new ExprError("proj expects two vectors of the same dimension");
        }
        case "diag": {
          // A stretch along the axes: the arguments go down the diagonal and
          // everything else is zero. Symbolic arguments flow through, so a
          // slider-driven diag(a, b) updates live like any other expression.
          if (args.some((a) => a.kind !== "scalar"))
            throw new ExprError("diag expects numbers");
          const d = args.map((a) => (a as Extract<Value, { kind: "scalar" }>).value);
          const z = P.constant(0);
          if (d.length === 2) return matrix([d[0], z, z, d[1]]);
          return matrix3([d[0], z, z, z, d[1], z, z, z, d[2]]);
        }
        case "eigen":
          // eigen doesn't produce a scalar/vector/matrix, so it can't take
          // part in a larger expression; App handles it at the top level.
          throw new ExprError("eigen(…) can only be used on its own");
        case "svd":
          // Same as eigen: a bundle of singular values and directions, not a
          // single value, so the sandbox handles it at the top level.
          throw new ExprError("svd(…) can only be used on its own");
        case "circle":
          throw new ExprError("circle() can only be used on its own");
        case "sphere":
          throw new ExprError("sphere() can only be used on its own");
      }
    }
  }
}

/** Names with built-in meaning that rows can't bind. */
export const RESERVED_NAMES = new Set([
  ...Object.keys(FN_ARITY),
  "x",
  "y",
  "z",
  "del",
]);

/**
 * If the row's source is a name binding like "u = M·v", split it into the
 * name and the expression text. Returns null for plain expressions.
 */
export function parseBinding(src: string): { name: string; expr: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)([\s\S]*)$/.exec(src);
  if (!m) return null;
  return { name: m[1], expr: m[2] };
}

/**
 * If the expression's top level is a product, return its factors in source
 * order (M·N·P -> [M, N, P]). Used to animate a composition one factor at a
 * time. Returns null if the root isn't a product.
 */
export function multiplicativeFactors(node: Node): Node[] | null {
  if (node.t !== "mul") return null;
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (n.t === "mul") {
      walk(n.a);
      walk(n.b);
    } else {
      out.push(n);
    }
  };
  walk(node);
  return out;
}

/**
 * If the expression's top level is a sum/difference, return each signed term
 * as a Node. Used to draw vector addition head-to-tail. Returns null if the
 * root isn't additive (so there's nothing to decompose).
 */
export function additiveTerms(node: Node): { sign: 1 | -1; node: Node }[] | null {
  if (node.t !== "add" && node.t !== "sub") return null;
  const out: { sign: 1 | -1; node: Node }[] = [];
  const walk = (n: Node, sign: 1 | -1) => {
    if (n.t === "add") {
      walk(n.a, sign);
      walk(n.b, sign);
    } else if (n.t === "sub") {
      walk(n.a, sign);
      walk(n.b, (sign === 1 ? -1 : 1) as 1 | -1);
    } else {
      out.push({ sign, node: n });
    }
  };
  walk(node, 1);
  return out;
}
