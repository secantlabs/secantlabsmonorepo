/**
 * Flux's document model: an ordered list of typed rows.
 *
 * Four row types, and that is the whole model (PRD §6.1): **field**, **point**,
 * **curve**, **slider**. Regions, scalar potentials, and expression rows carrying
 * integrals are shelved (§13).
 *
 * The one rule that matters here, carried over as a lesson from Warp: **every
 * cell evaluates in the full document environment.** In Warp, matrix and vector
 * cells are evaluated against an empty env, so putting a slider's name in a cell
 * silently yields 0 — which cost a lesson redesign. In Flux,
 * `F = (−a·y, a·x)` with `a` a slider works on the first try, and an unknown name
 * reports itself instead of quietly reading zero.
 */

import {
  evalAt,
  refs,
  tryParse,
  type Node,
  type Scope,
} from "@secantlabs/engine/elem";
import {
  arcLength,
  classifyNonFinite,
  curlPoly,
  divPoly,
  evalField,
  type Field2,
} from "@secantlabs/engine/field";
import { toText } from "@secantlabs/engine/poly";
import { fmt } from "./format";
import { resolveParamCurve, type ResolvedCurve } from "./geometry";

export type RowId = string;

let idCounter = 0;
export const newId = (): RowId => `r${++idCounter}`;

export interface FieldRow {
  id: RowId;
  kind: "field";
  name: string;
  /** [P, Q] — the Cartesian components, as raw input text. */
  cells: [string, string];
  shown: boolean;
}

/**
 * A draggable point. Desmos-style: a dot with a label, not an instrument.
 *
 * The coordinates are **text**, like every other cell in the document, rather
 * than numbers. That makes a blank new row trivial, sidesteps the "can't type a
 * minus sign" class of bug entirely, and — for free — lets a slider drive a
 * point: `p = (a, 0)` moves as you drag `a`.
 *
 * A point whose coordinates are plain numbers can be dragged on the canvas
 * (which rewrites them). One defined by an expression is drawn but not
 * draggable, so brushing past it can't silently destroy the expression.
 */
export interface PointRow {
  id: RowId;
  kind: "point";
  name: string;
  /** [x, y] as raw input text. */
  cells: [string, string];
  shown: boolean;
}

export interface CurveRow {
  id: RowId;
  kind: "curve";
  name: string;
  /** x(t), y(t) */
  cells: [string, string];
  t0: string;
  t1: string;
  shown: boolean;
}

export interface SliderRow {
  id: RowId;
  kind: "slider";
  name: string;
  value: number;
  min: string;
  max: string;
}

export type Row = FieldRow | PointRow | CurveRow | SliderRow;
export type RowKind = Row["kind"];

const POOLS: Record<RowKind, string[]> = {
  field: ["F", "G", "H", "K"],
  point: ["p", "q", "s"],
  curve: ["C", "D", "E"],
  slider: ["a", "b", "c", "k"],
};

/** First unused name from the pool for this kind. */
export function nextName(rows: Row[], kind: RowKind): string {
  const used = new Set(rows.map((r) => r.name));
  const pool = POOLS[kind];
  for (const n of pool) if (!used.has(n)) return n;
  const prefix = pool[0];
  let i = 1;
  while (used.has(prefix + i)) i++;
  return prefix + i;
}

export const newField = (rows: Row[]): FieldRow => ({
  id: newId(),
  kind: "field",
  name: nextName(rows, "field"),
  cells: ["", ""],
  shown: true,
});

export const newPoint = (rows: Row[]): PointRow => ({
  id: newId(),
  kind: "point",
  name: nextName(rows, "point"),
  cells: ["", ""],
  shown: true,
});

/**
 * A new curve is blank apart from its interval. The `t` range is scaffolding
 * rather than content — a sensible default there saves a step without putting
 * anything on the graph you didn't ask for.
 */
export const newCurve = (rows: Row[]): CurveRow => ({
  id: newId(),
  kind: "curve",
  name: nextName(rows, "curve"),
  cells: ["", ""],
  t0: "0",
  t1: "2pi",
  shown: true,
});

export const newSlider = (rows: Row[]): SliderRow => ({
  id: newId(),
  kind: "slider",
  name: nextName(rows, "slider"),
  value: 1,
  min: "-5",
  max: "5",
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Names bound more than once — flagged rather than silently shadowed. */
export function duplicateNames(rows: Row[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.name)) dupes.add(r.name);
    seen.add(r.name);
  }
  return dupes;
}

/** Numeric bindings a field or curve component may refer to: the sliders. */
export function buildScope(rows: Row[]): Scope {
  const scope = new Map<string, number>();
  for (const r of rows) if (r.kind === "slider") scope.set(r.name, r.value);
  return scope;
}

export interface ResolvedPoint {
  name: string;
  x: number;
  y: number;
  /** Both coordinates are plain numbers, so a drag may rewrite them. */
  draggable: boolean;
}

export interface Resolved {
  fields: Map<string, Field2>;
  curves: Map<string, ResolvedCurve>;
  /** Keyed by row id — the canvas and the handles both need the row back. */
  points: Map<RowId, ResolvedPoint>;
  scope: Scope;
  /** Per-row error text, keyed by row id. */
  errors: Map<RowId, string>;
}

/**
 * A point's coordinates are numbers, not positions, so x/y/r/theta must NOT be
 * bound as coordinate symbols here — `p = (x, 2)` is a mistake worth reporting,
 * not something that quietly reads x as 0.
 */
const POINT_OPTS = { symbols: {}, polar: false } as const;

/** Is this cell a plain signed decimal, and therefore safe for a drag to rewrite? */
const isLiteralNumber = (src: string): boolean =>
  /^\s*[-−+]?(\d+\.?\d*|\.\d+)\s*$/.test(src);

function unboundIn(node: Node, scope: Scope): string | null {
  for (const name of refs(node)) if (!scope.has(name)) return name;
  return null;
}

/**
 * Turn the document into engine-ready values. Errors are per-row and
 * non-fatal: a half-typed field shouldn't stop the rest of the scene drawing.
 */
export function resolve(rows: Row[]): Resolved {
  const scope = buildScope(rows);
  const dupes = duplicateNames(rows);
  const fields = new Map<string, Field2>();
  const curves = new Map<string, ResolvedCurve>();
  const points = new Map<RowId, ResolvedPoint>();
  const errors = new Map<RowId, string>();

  for (const r of rows) {
    if (dupes.has(r.name)) {
      errors.set(r.id, `"${r.name}" is defined more than once`);
      continue;
    }
    if (r.kind === "field") {
      const [sx, sy] = r.cells;
      if (!sx.trim() && !sy.trim()) continue; // empty row: not an error
      const nx = tryParse(sx || "0");
      const ny = tryParse(sy || "0");
      if (!nx || !ny) {
        errors.set(r.id, "Can't read that component");
        continue;
      }
      const missing = unboundIn(nx, scope) ?? unboundIn(ny, scope);
      if (missing) {
        errors.set(r.id, `Unknown name "${missing}"`);
        continue;
      }
      fields.set(r.name, { x: nx, y: ny });
    } else if (r.kind === "point") {
      const [sx, sy] = r.cells;
      if (!sx.trim() && !sy.trim()) continue; // a fresh blank row is not an error
      const nx = tryParse(sx, POINT_OPTS);
      const ny = tryParse(sy, POINT_OPTS);
      if (!nx || !ny) {
        errors.set(r.id, "Can't read that coordinate");
        continue;
      }
      const missing = unboundIn(nx, scope) ?? unboundIn(ny, scope);
      if (missing) {
        errors.set(r.id, `Unknown name "${missing}"`);
        continue;
      }
      try {
        const x = evalAt(nx, 0, 0, 0, scope);
        const y = evalAt(ny, 0, 0, 0, scope);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          errors.set(r.id, "That isn't a finite point");
          continue;
        }
        points.set(r.id, {
          name: r.name,
          x,
          y,
          draggable: isLiteralNumber(sx) && isLiteralNumber(sy),
        });
      } catch (e) {
        errors.set(r.id, e instanceof Error ? e.message : "Can't evaluate");
      }
    } else if (r.kind === "curve") {
      const [cx, cy] = r.cells;
      if (!cx.trim() && !cy.trim()) continue; // a fresh blank row is not an error
      const out = resolveParamCurve(cx, cy, r.t0, r.t1, scope);
      if ("error" in out) errors.set(r.id, out.error);
      else curves.set(r.name, out.ok);
    }
  }
  return { fields, curves, points, scope, errors };
}

// ---------------------------------------------------------------------------
// Row readouts — short computed values, never sentences (PRD §9)
// ---------------------------------------------------------------------------

export interface RowResult {
  /** Short mono lines under the row. */
  lines?: string[];
  error?: string;
}

/**
 * What a field row reports: `div` and `curl`, **exactly**, and only when the
 * components are polynomial — in which case both are a short closed form like
 * `2x + 3y` that is true everywhere. That exactness is the reason the Poly path
 * is kept alongside the numeric one: the identities hold as algebra rather than
 * as floating-point near-misses.
 *
 * When the components aren't polynomial the row prints **nothing**. The
 * operators genuinely vary from point to point, and the alternative — a
 * pointwise value with an `at (2.2325, 4.279)` suffix — was two long lines of
 * noise attached to a row most of the time, which is exactly what §9 says not to
 * do. Silence is the right answer, not a longer line.
 */
export function fieldResult(F: Field2, scope: Scope): RowResult {
  const d = divPoly(F, scope);
  const c = curlPoly(F, scope);
  if (d === null || c === null) return {};
  return { lines: [`div ${toText(d, fmt)}`, `curl ${toText(c, fmt)}`] };
}

/** What a point reports: the field vector there, if a field is present. */
export function pointResult(
  F: Field2 | null,
  fieldName: string | null,
  x: number,
  y: number,
  scope: Scope,
): RowResult {
  if (!F || !fieldName) return {};
  try {
    const v = evalField(F, x, y, scope);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
      // The canvas draws a circle for one of these and a square for the other;
      // the row has to say the same thing or they contradict each other.
      const kind = classifyNonFinite(F, x, y, 0.25, scope);
      return {
        lines: [
          kind === "overflow"
            ? `${fieldName} too large to represent here`
            : `${fieldName} undefined here`,
        ],
      };
    }
    return {
      lines: [
        `${fieldName} = (${fmt(v.x)}, ${fmt(v.y)})   |${fieldName}| = ${fmt(Math.hypot(v.x, v.y))}`,
      ],
    };
  } catch {
    return {};
  }
}

/** What a curve reports: its arc length. */
export function curveResult(rc: ResolvedCurve): RowResult {
  const len = arcLength(rc.curve);
  return { lines: [`length ${fmt(len.value)}`] };
}

/** The field everything else reads: the first visible, resolvable one. */
export function activeFieldName(
  rows: Row[],
  fields: Map<string, Field2>,
): string | null {
  for (const r of rows)
    if (r.kind === "field" && r.shown && fields.has(r.name)) return r.name;
  return null;
}

/** Evaluate a slider bound ("2pi", "-5") for the range input. */
export function bound(src: string, fallback: number): number {
  const n = tryParse(src);
  if (!n) return fallback;
  try {
    const v = evalAt(n, 0, 0, 0, new Map());
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
