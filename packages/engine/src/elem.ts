/**
 * Scalar expressions over the elementary functions — the field language.
 *
 * `expr.ts` represents every scalar as a polynomial in x, y, z, which is what
 * gives Warp exact symbolic differentiation. But the fields vector calculus is
 * *about* are not polynomials: the inverse-square field (x, y)/(x²+y²)^{3/2},
 * and (−y, x)/(x²+y²), whose curl vanishes everywhere it is defined while its
 * circulation around the origin is 2π. Neither is expressible in the ring.
 *
 * So this module adds a second, wider representation: an AST over + − × ÷ ^
 * and the elementary functions, evaluated numerically through dual numbers
 * (dual.ts) so partials come out exact to floating point. Nothing here
 * replaces the Poly path — `toPoly` below converts back whenever an
 * expression happens to be polynomial, so Flux still prints
 * "div F = 2x + 3y" exactly when it can.
 *
 * Deliberately additive: expr.ts is untouched, so Warp is unaffected.
 * Pure, no rendering deps.
 */

import * as D from "./dual";
import { type Dual } from "./dual";
import * as P from "./poly";
import { type Poly } from "./poly";

export class ElemError extends Error {}

/** Arity of every built-in. `r` and `theta` are sugar, handled at parse time. */
const FN_ARITY = {
  sin: 1,
  cos: 1,
  tan: 1,
  asin: 1,
  acos: 1,
  atan: 1,
  exp: 1,
  ln: 1,
  log: 1,
  log2: 1,
  sqrt: 1,
  cbrt: 1,
  abs: 1,
  sinh: 1,
  cosh: 1,
  tanh: 1,
  atan2: 2,
  hypot: 2,
  min: 2,
  max: 2,
} as const;
export type ElemFn = keyof typeof FN_ARITY;

export type Node =
  | { t: "num"; v: number }
  /** A coordinate: 0 = x, 1 = y, 2 = z. */
  | { t: "sym"; axis: 0 | 1 | 2 }
  /** A reference to another row — a slider, or a named scalar. */
  | { t: "ref"; name: string }
  | { t: "neg"; a: Node }
  | { t: "add"; a: Node; b: Node }
  | { t: "sub"; a: Node; b: Node }
  | { t: "mul"; a: Node; b: Node }
  | { t: "div"; a: Node; b: Node }
  | { t: "pow"; a: Node; b: Node }
  | { t: "call"; fn: ElemFn; args: Node[] };

/** Named constants, available as bare identifiers. */
const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
};

const SYMBOLS: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

const sym = (axis: 0 | 1 | 2): Node => ({ t: "sym", axis });

/**
 * Polar sugar, desugared at parse time so nothing downstream needs to know:
 *   r     → hypot(x, y)
 *   theta → atan2(y, x)
 *
 * These are the *planar* polar coordinates. When 3D lands (PRD phase 3) the
 * spherical radius needs its own name rather than a silent redefinition of
 * `r`, which would change the meaning of saved scenes.
 */
function polarSugar(name: string): Node | null {
  if (name === "r") return { t: "call", fn: "hypot", args: [sym(0), sym(1)] };
  if (name === "theta" || name === "th")
    return { t: "call", fn: "atan2", args: [sym(1), sym(0)] };
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizer — same shape as expr.ts's, plus "/" as a real operator
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" }
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
    } else if (c === "/" || c === "÷") {
      toks.push({ t: "op", v: "/" });
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
      throw new ElemError(`Unexpected character "${c}"`);
    }
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent), matching expr.ts's precedence conventions
// ---------------------------------------------------------------------------

/**
 * What identifiers mean as coordinates, and whether the polar shorthands are
 * available. Fields use the default (x, y, z with `r`/`theta`); a curve
 * parameterization instead binds a single parameter — `t` — and turns polar
 * sugar off, since `r` inside x(t) would silently mean √(t²) rather than
 * anything the author intended.
 */
export interface ParseOpts {
  symbols?: Record<string, 0 | 1 | 2>;
  polar?: boolean;
}

/** Bind one parameter name to the first axis — the shape a curve wants. */
export const PARAM_OPTS = (name = "t"): ParseOpts => ({
  symbols: { [name]: 0 },
  polar: false,
});

class Parser {
  private pos = 0;
  private symbols: Record<string, 0 | 1 | 2>;
  private polar: boolean;

  constructor(
    private toks: Tok[],
    opts: ParseOpts = {},
  ) {
    this.symbols = opts.symbols ?? SYMBOLS;
    this.polar = opts.polar ?? true;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  parse(): Node {
    const node = this.parseExpr();
    if (this.pos < this.toks.length)
      throw new ElemError("Unexpected trailing input");
    return node;
  }

  // expr := term (('+' | '-') term)*
  private parseExpr(): Node {
    let node = this.parseTerm();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && (p.v === "+" || p.v === "-")) {
        this.next();
        node = { t: p.v === "+" ? "add" : "sub", a: node, b: this.parseTerm() };
      } else break;
    }
    return node;
  }

  // term := factor ( ('*' | '/')? factor )*  — juxtaposition multiplies
  private parseTerm(): Node {
    let node = this.parseFactor();
    for (;;) {
      const p = this.peek();
      if (p?.t === "op" && (p.v === "*" || p.v === "/")) {
        this.next();
        node = {
          t: p.v === "*" ? "mul" : "div",
          a: node,
          b: this.parseFactor(),
        };
      } else if (p && (p.t === "num" || p.t === "id" || p.t === "lp")) {
        node = { t: "mul", a: node, b: this.parseFactor() };
      } else break;
    }
    return node;
  }

  // factor := ('-' | '+') factor | power
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

  // power := atom ('^' factor)?  — binds tighter than juxtaposition
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
    if (!tok) throw new ElemError("Unexpected end of expression");
    if (tok.t === "num") return { t: "num", v: tok.v };
    if (tok.t === "id") {
      const name = tok.v;
      if (name in FN_ARITY) {
        const fn = name as ElemFn;
        if (this.peek()?.t !== "lp")
          throw new ElemError(`${fn} expects parentheses`);
        this.next(); // (
        const args: Node[] = [this.parseExpr()];
        while (this.peek()?.t === "comma") {
          this.next();
          args.push(this.parseExpr());
        }
        if (this.next()?.t !== "rp") throw new ElemError("Missing )");
        const want = FN_ARITY[fn];
        if (args.length !== want)
          throw new ElemError(
            `${fn} expects ${want} argument${want === 1 ? "" : "s"}`,
          );
        return { t: "call", fn, args };
      }
      if (name in CONSTANTS) return { t: "num", v: CONSTANTS[name] };
      if (name in this.symbols) return sym(this.symbols[name]);
      if (this.polar) {
        const sugar = polarSugar(name);
        if (sugar) return sugar;
      }
      return { t: "ref", name };
    }
    if (tok.t === "lp") {
      const inner = this.parseExpr();
      if (this.next()?.t !== "rp") throw new ElemError("Missing )");
      return inner;
    }
    throw new ElemError("Unexpected token");
  }
}

export function parse(src: string, opts?: ParseOpts): Node {
  const t = src.trim();
  if (!t) throw new ElemError("Empty expression");
  return new Parser(tokenize(t), opts).parse();
}

/** Parse, or null on any syntax error — for live-typing UI that shouldn't shout. */
export function tryParse(src: string, opts?: ParseOpts): Node | null {
  try {
    return parse(src, opts);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Evaluation through dual numbers
// ---------------------------------------------------------------------------

/** Numeric bindings for `ref` nodes — slider values and named scalars. */
export type Scope = ReadonlyMap<string, number>;

const EMPTY_SCOPE: Scope = new Map();

/**
 * Evaluate at (x, y, z), returning the value *and* its exact gradient.
 * Unknown identifiers throw — a field referring to a row that doesn't exist
 * is an error worth reporting, not a silent zero.
 */
export function evalDual(
  node: Node,
  x: number,
  y: number,
  z = 0,
  scope: Scope = EMPTY_SCOPE,
): Dual {
  const X = D.variable(x, 0);
  const Y = D.variable(y, 1);
  const Z = D.variable(z, 2);

  const go = (n: Node): Dual => {
    switch (n.t) {
      case "num":
        return D.constant(n.v);
      case "sym":
        return n.axis === 0 ? X : n.axis === 1 ? Y : Z;
      case "ref": {
        const v = scope.get(n.name);
        if (v === undefined) throw new ElemError(`Unknown name "${n.name}"`);
        return D.constant(v);
      }
      case "neg":
        return D.neg(go(n.a));
      case "add":
        return D.add(go(n.a), go(n.b));
      case "sub":
        return D.sub(go(n.a), go(n.b));
      case "mul":
        return D.mul(go(n.a), go(n.b));
      case "div":
        return D.div(go(n.a), go(n.b));
      case "pow":
        return D.pow(go(n.a), go(n.b));
      case "call": {
        const a = go(n.args[0]);
        switch (n.fn) {
          case "sin":
            return D.sin(a);
          case "cos":
            return D.cos(a);
          case "tan":
            return D.tan(a);
          case "asin":
            return D.asin(a);
          case "acos":
            return D.acos(a);
          case "atan":
            return D.atan(a);
          case "exp":
            return D.exp(a);
          case "ln":
          case "log":
            return D.ln(a);
          case "log2":
            return D.log2(a);
          case "sqrt":
            return D.sqrt(a);
          case "cbrt":
            return D.cbrt(a);
          case "abs":
            return D.abs(a);
          case "sinh":
            return D.sinh(a);
          case "cosh":
            return D.cosh(a);
          case "tanh":
            return D.tanh(a);
          case "atan2":
            return D.atan2(a, go(n.args[1]));
          case "hypot":
            return D.hypot(a, go(n.args[1]));
          case "min":
            return D.min(a, go(n.args[1]));
          case "max":
            return D.max(a, go(n.args[1]));
        }
      }
    }
  };

  return go(node);
}

/** Just the value, when the gradient isn't needed. */
export function evalAt(
  node: Node,
  x: number,
  y: number,
  z = 0,
  scope: Scope = EMPTY_SCOPE,
): number {
  return evalDual(node, x, y, z, scope).v;
}

/** Names this expression refers to — for dependency ordering and error text. */
export function refs(node: Node, out: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case "ref":
      out.add(node.name);
      break;
    case "neg":
      refs(node.a, out);
      break;
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "pow":
      refs(node.a, out);
      refs(node.b, out);
      break;
    case "call":
      for (const a of node.args) refs(a, out);
      break;
    case "num":
    case "sym":
      break;
  }
  return out;
}

/** True when the expression mentions no coordinate — a constant field component. */
export function isConstantIn(node: Node): boolean {
  switch (node.t) {
    case "sym":
      return false;
    case "num":
    case "ref":
      return true;
    case "neg":
      return isConstantIn(node.a);
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "pow":
      return isConstantIn(node.a) && isConstantIn(node.b);
    case "call":
      return node.args.every(isConstantIn);
  }
}

// ---------------------------------------------------------------------------
// The bridge back to the polynomial ring
// ---------------------------------------------------------------------------

/**
 * Convert to a Poly, or null when the expression isn't polynomial in x, y, z.
 *
 * This is what keeps the exact symbolic story alive: when a field happens to
 * be polynomial, Flux can differentiate it with `P.diff` and print the result
 * exactly ("div F = 2x + 3y"), and the identities — curl of a gradient is 0,
 * divergence of a curl is 0 — hold as *algebra* rather than as floating-point
 * near-misses. Non-polynomial fields fall back to the dual-number path, which
 * is numerically exact but has nothing to print.
 *
 * `scope` folds slider values in as numeric coefficients, exactly as Warp's
 * sliders do — so `a·y` with a = 2 becomes the polynomial 2y.
 */
export function toPoly(node: Node, scope: Scope = EMPTY_SCOPE): Poly | null {
  switch (node.t) {
    case "num":
      return P.constant(node.v);
    case "sym":
      return P.symbol(node.axis);
    case "ref": {
      const v = scope.get(node.name);
      return v === undefined ? null : P.constant(v);
    }
    case "neg": {
      const a = toPoly(node.a, scope);
      return a === null ? null : P.scale(a, -1);
    }
    case "add":
    case "sub": {
      const a = toPoly(node.a, scope);
      const b = toPoly(node.b, scope);
      if (a === null || b === null) return null;
      return P.add(a, b, node.t === "add" ? 1 : -1);
    }
    case "mul": {
      const a = toPoly(node.a, scope);
      const b = toPoly(node.b, scope);
      if (a === null || b === null) return null;
      return P.mul(a, b);
    }
    case "div": {
      // Polynomial only when the denominator is a nonzero constant —
      // 1/x is famously not a polynomial, and pretending otherwise is how
      // a symbolic engine starts lying.
      const a = toPoly(node.a, scope);
      const b = toPoly(node.b, scope);
      if (a === null || b === null || !P.isConst(b)) return null;
      const d = P.constValue(b);
      if (d === 0) return null;
      return P.scale(a, 1 / d);
    }
    case "pow": {
      const a = toPoly(node.a, scope);
      const b = toPoly(node.b, scope);
      if (a === null || b === null || !P.isConst(b)) return null;
      const n = P.constValue(b);
      if (!Number.isInteger(n) || n < 0) return null;
      return P.pow(a, n);
    }
    case "call":
      // Every elementary function leaves the ring. `hypot(3, 4)` is a constant
      // in principle, but recognizing that is a simplifier's job, not this
      // function's — and the dual path handles it correctly regardless.
      return null;
  }
}
