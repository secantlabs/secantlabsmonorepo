/**
 * Draggable handles, and the selection model behind them.
 *
 * Every canvas interaction is built on **selection plus nudge**, not on dragging:
 * there is a list of handles, one may be selected, and it moves by arrow keys
 * with modifier-scaled steps. Pointer dragging is a *second* driver of that same
 * model.
 *
 * That ordering is the point (PRD §8.2). A drag-only tool is unshippable to a
 * campus that procures against WCAG, and retrofitting keyboard operation means
 * rewriting every interaction.
 */

import { type ResolvedPoint, type Row, type RowId } from "./rows";

export interface Handle {
  /** Stable across renders so selection survives a drag. */
  id: string;
  rowId: RowId;
  x: number;
  y: number;
  /** Spoken when this handle is selected. */
  label: string;
}

/**
 * Every handle the current document exposes, in a stable order for Tab.
 *
 * Only points whose coordinates are plain numbers get one. A point defined by an
 * expression (`p = (a, 0)`) still draws and still follows its slider, but has no
 * handle — so brushing past it can't silently overwrite the expression with a
 * pair of literals.
 */
export function collectHandles(
  rows: Row[],
  points: Map<RowId, ResolvedPoint>,
): Handle[] {
  const out: Handle[] = [];
  for (const r of rows) {
    if (r.kind !== "point" || !r.shown) continue;
    const p = points.get(r.id);
    if (!p || !p.draggable) continue;
    out.push({
      id: `${r.id}:p`,
      rowId: r.id,
      x: p.x,
      y: p.y,
      label: `point ${r.name}`,
    });
  }
  return out;
}

/** Text for a dragged coordinate: short enough to read, precise enough to keep. */
const coord = (n: number): string => String(Math.round(n * 1e4) / 1e4);

/** Apply an absolute move to a handle's row — the pointer-drag path. */
export function moveHandle(
  row: Row,
  x: number,
  y: number,
): Partial<Row> | null {
  if (row.kind !== "point") return null;
  return { cells: [coord(x), coord(y)] as [string, string] };
}

/**
 * Apply a *relative* move — the keyboard path.
 *
 * Reading the row's own current coordinates rather than the handle's means
 * consecutive nudges compose even when they arrive faster than a re-render,
 * which is exactly what key repeat does.
 */
export function nudgeRow(
  row: Row,
  dx: number,
  dy: number,
): Partial<Row> | null {
  if (row.kind !== "point") return null;
  const x = Number(row.cells[0].replace("−", "-"));
  const y = Number(row.cells[1].replace("−", "-"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { cells: [coord(x + dx), coord(y + dy)] as [string, string] };
}

/**
 * Step size in world units for a keyboard nudge.
 *
 * Three sizes rather than one: a plain arrow moves a readable amount, ⇧ moves
 * coarsely for crossing the screen, ⌥ moves finely for landing on a value. All
 * three are in *pixels* converted to world units, so the felt step is the same
 * at every zoom level.
 */
export function nudgeStep(
  scale: number,
  e: { shiftKey: boolean; altKey: boolean },
): number {
  const px = e.shiftKey ? 40 : e.altKey ? 1 : 8;
  return px / scale;
}
