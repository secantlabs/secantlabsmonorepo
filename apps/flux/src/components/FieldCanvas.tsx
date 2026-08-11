/**
 * The 2D stage: a sampled vector field, with points and curves drawn on top.
 *
 * Three rendering decisions here are load-bearing rather than cosmetic, and with
 * the measurement layer shelved they are now most of the product:
 *
 *   - **Arrow length saturates.** Near a singularity |F| runs to infinity, and
 *     arrows proportional to magnitude become a black smear that destroys the
 *     picture — the classic failure of hand-rolled field plotters. Length runs
 *     through tanh, so it compresses smoothly instead of clipping. Order is
 *     always preserved: a longer arrow is always a bigger vector.
 *   - **Magnitude is carried by two channels.** Length *and* colour lightness, so
 *     the picture survives a colour-vision deficiency and a greyscale printout.
 *     The ramp is single-hue lightness, which is inherently safe (PRD §8.4) — and
 *     chosen now, because a late palette change invalidates every screenshot.
 *   - **Singularities are marked, not rendered.** An open circle where the field
 *     is undefined, rather than whatever chaos sampling produces there. Drawing
 *     nothing would read as "the field is zero here", which is the opposite.
 *     An open *square* means something different: the field is defined there but
 *     its magnitude left the range of a double (see `classifyNonFinite`).
 *
 * What counts as a singularity is decided by **divergence under refinement**, and
 * never by comparing a magnitude to the rest of the window. An earlier version
 * marked any sample exceeding 60× the window median, which conflates "large" with
 * "undefined": `(e^x, 2)` put 275–486 false markers on screen and cost ~35,000
 * field evaluations a frame hunting them. A pole is the thing whose magnitude
 * keeps *growing* as you shrink a box onto it; every smooth field's peak
 * converges, however enormous it is.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  classifyNonFinite,
  evalField,
  type Field2,
} from "@secantlabs/engine/field";
import { type Scope } from "@secantlabs/engine/elem";
import { type Pt } from "@secantlabs/engine/quad";
import {
  FIELD_STRONG_RGB,
  FIELD_WEAK_RGB,
  GRAPH,
  lerpColor,
} from "../colors";
import { nudgeStep, type Handle } from "../handles";
import { type View } from "../persist";

export interface CanvasField {
  name: string;
  F: Field2;
}

export interface CanvasCurve {
  name: string;
  points: Pt[];
  closed: boolean;
}

export interface CanvasPoint {
  name: string;
  x: number;
  y: number;
}

interface Props {
  fields: CanvasField[];
  curves: CanvasCurve[];
  points: CanvasPoint[];
  handles: Handle[];
  selected: string | null;
  scope: Scope;
  view: View;
  /** Concise screen-reader label (PRD §8.1) — a label, not exposition. */
  description: string;
  onViewChange: (v: View) => void;
  /** Absolute move — a pointer drag knows exactly where it is. */
  onHandleMove: (handle: Handle, x: number, y: number) => void;
  /**
   * Relative move — a keyboard nudge must compose. Computing an absolute
   * position from the handle would read a value that may be a render behind, so
   * two fast presses (or key repeat) would clobber each other instead of adding.
   */
  onHandleNudge: (handle: Handle, dx: number, dy: number) => void;
  onSelect: (handleId: string | null) => void;
  focusRef?: React.RefObject<HTMLCanvasElement>;
}

const COLORS = {
  bg: "#ffffff",
  grid: "#e4e8ee",
  axis: "#3c4350",
  label: "#7a828f",
  // Everything the expression list also shows lives in colors.ts, so a row's
  // dot can never disagree with what that row draws.
  fieldWeak: FIELD_WEAK_RGB,
  fieldStrong: FIELD_STRONG_RGB,
  singular: GRAPH.singular,
  curve: GRAPH.curve,
  point: GRAPH.point,
  handle: "#ffffff",
  selected: GRAPH.selected,
};

/** Target pixel spacing between arrow roots — dense enough to read as a field. */
const ARROW_SPACING_PX = 36;
/** Arrow length ceiling, as a fraction of the lattice spacing. */
const ARROW_FILL = 0.86;
/** Hit radius for grabbing a handle with a pointer, in pixels. */
const HANDLE_HIT_PX = 12;

/**
 * Pole hunting, all three numbers measured rather than guessed.
 *
 * REFINE_STEPS: halvings of the search box. The old code stopped after 12 *and*
 * bailed out early whenever a round found no improvement — which aborts the
 * search before the box is small enough to reach a pole sitting very close to a
 * lattice point. Removing that bail-out took a 12-case pole battery from 4 misses
 * to 0.
 *
 * POLE_GROWTH: how much the running peak must grow across the late half of the
 * refinement to count as divergent. Measured: real poles grow ≥ 1024×, while
 * `(e^x, 2)`, `(e^(3x), 2)` (peaking at 3.9e17) and `(x⁴, y⁴)` all grow 1.00×.
 * Three orders of magnitude of headroom either side of 4.
 *
 * MAX_CANDIDATES: a hard ceiling on hunts per frame, so a pathological field
 * cannot starve the frame budget. Real scenes have a handful of poles.
 */
const REFINE_STEPS = 22;
const POLE_GROWTH = 4;
const MAX_CANDIDATES = 24;

const NEIGHBOURS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function niceStep(scale: number, targetPx = 84): number {
  const target = targetPx / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const f = target / pow;
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * pow;
}

function formatTick(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  if (r === 0) return "0";
  return String(r).replace("-", "−");
}

export default function FieldCanvas({
  fields,
  curves,
  points,
  handles,
  selected,
  scope,
  view,
  description,
  onViewChange,
  onHandleMove,
  onHandleNudge,
  onSelect,
  focusRef,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const canvasRef = focusRef ?? ref;

  // Live refs so the pointer/key listeners never re-subscribe mid-drag.
  const viewRef = useRef(view);
  viewRef.current = view;
  const handlesRef = useRef(handles);
  handlesRef.current = handles;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    let mode: "none" | "pan" | "handle" = "none";
    let grabbed: Handle | null = null;
    let lastX = 0;
    let lastY = 0;

    const toWorld = (clientX: number, clientY: number): Pt => {
      const v = viewRef.current;
      const rect = c.getBoundingClientRect();
      return {
        x: v.cx + (clientX - rect.left - rect.width / 2) / v.scale,
        y: v.cy - (clientY - rect.top - rect.height / 2) / v.scale,
      };
    };

    const hitHandle = (clientX: number, clientY: number): Handle | null => {
      const v = viewRef.current;
      const w = toWorld(clientX, clientY);
      let best: Handle | null = null;
      let bestD = Infinity;
      for (const h of handlesRef.current) {
        const d = Math.hypot(h.x - w.x, h.y - w.y) * v.scale;
        if (d <= HANDLE_HIT_PX && d < bestD) {
          bestD = d;
          best = h;
        }
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      c.focus();
      const hit = hitHandle(e.clientX, e.clientY);
      if (hit) {
        mode = "handle";
        grabbed = hit;
        onSelect(hit.id);
      } else {
        mode = "pan";
        onSelect(null);
      }
      lastX = e.clientX;
      lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (mode === "handle" && grabbed) {
        const w = toWorld(e.clientX, e.clientY);
        onHandleMove(grabbed, w.x, w.y);
        return;
      }
      if (mode !== "pan") {
        c.style.cursor = hitHandle(e.clientX, e.clientY) ? "grab" : "";
        return;
      }
      const v = viewRef.current;
      onViewChange({
        ...v,
        cx: v.cx - (e.clientX - lastX) / v.scale,
        cy: v.cy + (e.clientY - lastY) / v.scale,
      });
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      mode = "none";
      grabbed = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = c.getBoundingClientRect();
      // Zoom about the cursor: the world point under it stays put.
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      const wx = v.cx + px / v.scale;
      const wy = v.cy - py / v.scale;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(4000, Math.max(4, v.scale * factor));
      onViewChange({ scale, cx: wx - px / scale, cy: wy + py / scale });
    };

    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
      c.removeEventListener("wheel", onWheel);
    };
  }, [canvasRef, onViewChange, onHandleMove, onSelect]);

  /**
   * Keyboard equivalents for every pointer gesture (PRD §8.2). Tab cycles
   * handles; arrows move the selected one, or pan when nothing is selected.
   */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onKey = (e: KeyboardEvent) => {
      const v = viewRef.current;
      const hs = handlesRef.current;
      const current = hs.find((h) => h.id === selectedRef.current) ?? null;

      // Tab cycles, then releases focus past the last handle so the page's tab
      // order isn't a trap.
      if (e.key === "Tab" && hs.length > 0) {
        const i = current ? hs.findIndex((h) => h.id === current.id) : -1;
        const next = e.shiftKey ? i - 1 : i + 1;
        if (next < -1 || next >= hs.length) {
          onSelect(null);
          return;
        }
        onSelect(next === -1 ? null : hs[next].id);
        e.preventDefault();
        return;
      }

      if (e.key === "Escape" && current) {
        onSelect(null);
        e.preventDefault();
        return;
      }

      const arrow =
        e.key === "ArrowLeft"
          ? [-1, 0]
          : e.key === "ArrowRight"
            ? [1, 0]
            : e.key === "ArrowUp"
              ? [0, 1]
              : e.key === "ArrowDown"
                ? [0, -1]
                : null;

      if (arrow) {
        if (current) {
          const step = nudgeStep(v.scale, e);
          onHandleNudge(current, arrow[0] * step, arrow[1] * step);
        } else {
          const step = (e.shiftKey ? 128 : e.altKey ? 8 : 32) / v.scale;
          onViewChange({
            ...v,
            cx: v.cx + arrow[0] * step,
            cy: v.cy + arrow[1] * step,
          });
        }
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case "+":
        case "=":
          onViewChange({ ...v, scale: Math.min(4000, v.scale * 1.25) });
          break;
        case "-":
        case "_":
          onViewChange({ ...v, scale: Math.max(4, v.scale / 1.25) });
          break;
        case "0":
          onViewChange({ cx: 0, cy: 0, scale: 64 });
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    c.addEventListener("keydown", onKey);
    return () => c.removeEventListener("keydown", onKey);
  }, [canvasRef, onViewChange, onHandleNudge, onSelect]);

  /**
   * The latest draw, and one shared animation frame. Keeping the draw behind a
   * ref is what lets the ResizeObserver live in a mount-only effect: a zoom
   * gesture changes `view` on every wheel tick, and rebuilding an observer that
   * often is pure waste (it also fires an immediate observation each time).
   */
  const drawRef = useRef<() => void>(() => {});
  const frameRef = useRef(0);
  const schedule = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    return () => ro.disconnect();
  }, [canvasRef, schedule]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, w, h);

      const { cx, cy, scale } = view;
      const toPx = (x: number, y: number): [number, number] => [
        w / 2 + (x - cx) * scale,
        h / 2 - (y - cy) * scale,
      ];
      const x0 = cx - w / 2 / scale;
      const x1 = cx + w / 2 / scale;
      const y0 = cy - h / 2 / scale;
      const y1 = cy + h / 2 / scale;

      // --- grid + axes ----------------------------------------------------
      const step = niceStep(scale);
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
        const [px] = toPx(gx, 0);
        ctx.moveTo(Math.round(px) + 0.5, 0);
        ctx.lineTo(Math.round(px) + 0.5, h);
      }
      for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
        const [, py] = toPx(0, gy);
        ctx.moveTo(0, Math.round(py) + 0.5);
        ctx.lineTo(w, Math.round(py) + 0.5);
      }
      ctx.stroke();

      ctx.strokeStyle = COLORS.axis;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const [ox, oy] = toPx(0, 0);
      if (oy >= 0 && oy <= h) {
        ctx.moveTo(0, Math.round(oy) + 0.5);
        ctx.lineTo(w, Math.round(oy) + 0.5);
      }
      if (ox >= 0 && ox <= w) {
        ctx.moveTo(Math.round(ox) + 0.5, 0);
        ctx.lineTo(Math.round(ox) + 0.5, h);
      }
      ctx.stroke();

      ctx.fillStyle = COLORS.label;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const labelY = Math.min(Math.max(oy + 4, 4), h - 16);
      for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
        if (Math.abs(gx) < step / 2) continue;
        const [px] = toPx(gx, 0);
        ctx.fillText(formatTick(gx), px, labelY);
      }
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const labelX = Math.min(Math.max(ox - 6, 28), w - 4);
      for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
        if (Math.abs(gy) < step / 2) continue;
        const [, py] = toPx(0, gy);
        ctx.fillText(formatTick(gy), labelX, py);
      }

      // --- the fields, then the geometry on top ---------------------------
      for (const cf of fields) drawArrows(ctx, cf.F, scope, view, w, h);
      for (const cv of curves) drawCurve(ctx, cv, toPx);
      for (const p of points) drawPoint(ctx, p, toPx);
      drawHandles(ctx, handles, selected, toPx);
    };

    drawRef.current = draw;
    schedule();
    return () => cancelAnimationFrame(frameRef.current);
    // Every input is memoized upstream in App, so identity changes track real
    // scene changes. Do NOT replace this with a summary string — an earlier
    // version did, silently omitted the field *expressions*, and the canvas kept
    // drawing a stale field while every readout updated correctly.
  }, [canvasRef, view, fields, curves, points, handles, selected, scope]);

  const selectedHandle = handles.find((h) => h.id === selected) ?? null;

  return (
    <canvas
      ref={canvasRef}
      className="field-canvas"
      tabIndex={0}
      role="application"
      aria-label={
        selectedHandle
          ? `${selectedHandle.label} selected at ${round(selectedHandle.x)}, ${round(
              selectedHandle.y,
            )}. Arrow keys move it; Escape deselects. ${description}`
          : `${description}${
              handles.length
                ? ` Press Tab to select one of ${handles.length} draggable points.`
                : ""
            }`
      }
    />
  );
}

const round = (n: number): string =>
  String(Math.round(n * 1000) / 1000).replace("-", "−");

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

function drawArrows(
  ctx: CanvasRenderingContext2D,
  F: Field2,
  scope: Scope,
  view: View,
  w: number,
  h: number,
) {
  const { cx, cy, scale } = view;
  const toPx = (x: number, y: number): [number, number] => [
    w / 2 + (x - cx) * scale,
    h / 2 - (y - cy) * scale,
  ];

  /**
   * The lattice is aligned to *world* coordinates, not canvas pixels: sample
   * points sit at whole multiples of a round spacing, so the origin is always
   * one of them. Anchoring to the canvas would put samples at arbitrary world
   * positions — a field singular at the origin would get its marker only by
   * luck, and the arrows would slide under the field as you pan instead of the
   * field sliding under a fixed sampling.
   */
  const spacing = niceStep(scale, ARROW_SPACING_PX);
  const maxLen = spacing * scale * ARROW_FILL;

  const x0 = cx - w / 2 / scale;
  const x1 = cx + w / 2 / scale;
  const y0 = cy - h / 2 / scale;
  const y1 = cy + h / 2 / scale;

  interface Sample {
    x: number;
    y: number;
    vx: number;
    vy: number;
    mag: number;
    /** Lattice indices, so neighbours are a map lookup rather than a search. */
    i: number;
    j: number;
  }
  const samples: Sample[] = [];
  const grid = new Map<string, Sample>();
  const singular: [number, number][] = [];
  const overflow: [number, number][] = [];
  const mags: number[] = [];
  const key = (i: number, j: number) => `${i},${j}`;

  const sample = (x: number, y: number): { x: number; y: number } | null => {
    try {
      return evalField(F, x, y, scope);
    } catch {
      return null;
    }
  };

  let iMin = Infinity;
  let iMax = -Infinity;
  let jMin = Infinity;
  let jMax = -Infinity;

  for (let gx = Math.ceil(x0 / spacing) * spacing; gx <= x1; gx += spacing) {
    for (let gy = Math.ceil(y0 / spacing) * spacing; gy <= y1; gy += spacing) {
      // Snap to exact multiples so float drift never nudges the origin off it.
      const x = Math.round(gx / spacing) * spacing;
      const y = Math.round(gy / spacing) * spacing;
      const i = Math.round(x / spacing);
      const j = Math.round(y / spacing);
      if (i < iMin) iMin = i;
      if (i > iMax) iMax = i;
      if (j < jMin) jMin = j;
      if (j > jMax) jMax = j;
      const v = sample(x, y);
      if (!v) return; // unresolvable field draws nothing; the row reports why
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
        // Undefined, or merely too big for a double? They mean different things
        // and get different marks.
        const kind = classifyNonFinite(F, x, y, spacing * 0.5, scope);
        (kind === "overflow" ? overflow : singular).push(toPx(x, y));
        continue;
      }
      const mag = Math.hypot(v.x, v.y);
      if (mag > 0) mags.push(mag);
      const s: Sample = { x, y, vx: v.x, vy: v.y, mag, i, j };
      samples.push(s);
      grid.set(key(i, j), s);
    }
  }

  /**
   * The magnitude that maps to a "medium" arrow: the **median** over the visible
   * window, not the mean. A single near-singular sample drags a mean upward and
   * washes the whole picture pale — exactly what happens on any 1/r field.
   */
  const sorted = [...mags].sort((a, b) => a - b);
  const ref = sorted.length ? sorted[Math.floor(sorted.length / 2)] || 1 : 1;

  /**
   * Poles between lattice points, so a marker doesn't depend on a sample landing
   * exactly on the bad point.
   *
   * The prefilter is "is this a local maximum of |F| among its eight lattice
   * neighbours", which costs **no** extra field evaluations — the magnitudes are
   * already in hand — and is the right topological condition, since a pole is a
   * local maximum. Ties must not disqualify, or a pole equidistant from four
   * lattice points is never a candidate. Boundary samples are skipped: their
   * neighbourhood is incomplete, so "local maximum" is unknowable there.
   *
   * On `(e^x, 2)` this admits **zero** candidates where the old median test
   * admitted 300–400.
   */
  const candidates: { x: number; y: number; mag: number }[] = [];
  for (const s of samples) {
    if (s.i === iMin || s.i === iMax || s.j === jMin || s.j === jMax) continue;
    if (s.mag < ref * 2) continue;
    let isMax = true;
    for (const [di, dj] of NEIGHBOURS) {
      const n = grid.get(key(s.i + di, s.j + dj));
      if (n && n.mag > s.mag) {
        isMax = false;
        break;
      }
    }
    if (isMax) candidates.push(s);
  }
  candidates.sort((a, b) => b.mag - a.mag);
  if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES;

  for (const s of findPoles(candidates, spacing, F, scope, sample)) {
    (s.kind === "overflow" ? overflow : singular).push(toPx(s.x, s.y));
  }

  for (const s of samples) {
    const [px, py] = toPx(s.x, s.y);
    if (s.mag === 0) {
      // A zero of the field is worth seeing — a small dot, not a gap.
      ctx.fillStyle = lerpColor(COLORS.fieldWeak, COLORS.fieldStrong, 0);
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // tanh compresses smoothly and monotonically: order is always preserved,
    // and nothing ever exceeds the lattice spacing.
    const t = Math.tanh(s.mag / (ref * 1.6));
    const len = maxLen * (0.22 + 0.78 * t);
    const ux = s.vx / s.mag;
    const uy = -s.vy / s.mag; // canvas y grows downward
    const color = lerpColor(COLORS.fieldWeak, COLORS.fieldStrong, t);

    // Tail-anchored: F(p) is drawn *at* p, as every textbook and plotting
    // library does it. Centring would read better in dense regions but quietly
    // misplaces the vector.
    const tipX = px + ux * len;
    const tipY = py + uy * len;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1 + 1.1 * t;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    arrowHead(ctx, tipX, tipY, ux, uy, color, Math.min(len * 0.42, 3.2 + 3.6 * t));

    // A dot at the root, so the sample point stays visible where the arrow is short.
    ctx.beginPath();
    ctx.arc(px, py, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawOverflowMarks(ctx, overflow);
  drawSingularMarks(ctx, singular);
}

/** An open circle: "undefined here" as a statement, not an absence. */
function drawSingularMarks(
  ctx: CanvasRenderingContext2D,
  at: [number, number][],
) {
  if (!at.length) return;
  ctx.strokeStyle = COLORS.singular;
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1.8;
  for (const [px, py] of at) {
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * An open square: the field is defined here, but its magnitude is past what a
 * double can hold. A different *shape* rather than a different colour, so the
 * distinction survives any colour vision (PRD §8.4) — and a lighter stroke,
 * because overflow covers whole regions rather than isolated points and a region
 * of heavy marks would read as a wall of alarms.
 */
function drawOverflowMarks(
  ctx: CanvasRenderingContext2D,
  at: [number, number][],
) {
  if (!at.length) return;
  ctx.strokeStyle = COLORS.singular;
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1.1;
  const r = 3.6;
  for (const [px, py] of at) {
    ctx.beginPath();
    ctx.rect(px - r, py - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Confirm or reject each candidate as a pole, by **divergence under
 * refinement**.
 *
 * Climb toward increasing |F| on a box that halves each round, recording the
 * running peak. Near a pole the climb keeps homing in, the distance to the pole
 * keeps halving, and |F| ~ dist^−k keeps multiplying — the peak runs away. On a
 * smooth field the climb can travel at most about one spacing in total (the
 * steps form a geometric series) and |F| is Lipschitz there, so the peak
 * plateaus. Comparing the late peak to the mid-climb peak therefore separates
 * the two *regardless of how large the field is*, which is the property the old
 * "60× the window median" test lacked.
 */
function findPoles(
  candidates: { x: number; y: number; mag: number }[],
  spacing: number,
  F: Field2,
  scope: Scope,
  sample: (x: number, y: number) => { x: number; y: number } | null,
): { x: number; y: number; kind: "singular" | "overflow" }[] {
  const found: { x: number; y: number; kind: "singular" | "overflow" }[] = [];

  const magAt = (x: number, y: number): number => {
    const v = sample(x, y);
    if (!v) return 0;
    const m = Math.hypot(v.x, v.y);
    return Number.isFinite(m) ? m : Infinity;
  };

  for (const c of candidates) {
    let bx = c.x;
    let by = c.y;
    let best = c.mag;
    let box = spacing;
    const trace: number[] = [best];

    for (let iter = 0; iter < REFINE_STEPS; iter++) {
      box /= 2;
      for (const [dx, dy] of NEIGHBOURS) {
        const m = magAt(bx + dx * box, by + dy * box);
        if (m > best) {
          best = m;
          bx += dx * box;
          by += dy * box;
        }
      }
      trace.push(best);
      // Landing exactly on the pole is a confirmation, not a reason to keep
      // refining. (Unlike the old `!moved` bail-out, which aborted the search
      // while the box was still too coarse to reach a nearby pole at all.)
      if (!Number.isFinite(best)) break;
    }

    const mid = trace[Math.floor(trace.length / 2)];
    const end = trace[trace.length - 1];
    const diverging =
      !Number.isFinite(end) || (mid > 0 && end / mid >= POLE_GROWTH);
    if (!diverging) continue;

    // Several lattice points climb to the same peak; keep one per cluster and
    // snap to a round value, so a singularity at the origin reads as (0, 0).
    if (found.some((f) => Math.hypot(f.x - bx, f.y - by) < spacing * 0.9))
      continue;
    // A runaway peak still has to be told apart from a field that simply left
    // double range on the way up.
    const kind = Number.isFinite(end)
      ? "singular"
      : classifyNonFinite(F, bx, by, box * 2 || spacing * 1e-6, scope);
    found.push({ x: snap(bx, spacing), y: snap(by, spacing), kind });
  }
  return found;
}

function snap(v: number, spacing: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < spacing * 0.1 ? r : v;
}

// ---------------------------------------------------------------------------
// Curves and points
// ---------------------------------------------------------------------------

type ToPx = (x: number, y: number) => [number, number];

function drawCurve(
  ctx: CanvasRenderingContext2D,
  cv: CanvasCurve,
  toPx: ToPx,
) {
  if (cv.points.length < 2) return;
  const pts = cv.points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => toPx(p.x, p.y));
  if (pts.length < 2) return;

  ctx.strokeStyle = COLORS.curve;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (cv.closed) ctx.closePath();
  ctx.stroke();

  // Direction marks spaced along the path, so a densely sampled parameterization
  // doesn't become a solid row of arrowheads.
  let acc = 0;
  const SPACING = 78;
  const n = cv.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const m = Math.hypot(dx, dy);
    if (m < 1e-6) continue;
    acc += m;
    if (acc < SPACING) continue;
    acc = 0;
    arrowHead(ctx, b[0], b[1], dx / m, dy / m, COLORS.curve, 8);
  }

  // Endpoints of an open curve — where the parameterization starts and stops.
  if (!cv.closed) {
    ctx.fillStyle = COLORS.curve;
    for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(px, py, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A Desmos-style point: a filled dot with its name beside it. */
function drawPoint(
  ctx: CanvasRenderingContext2D,
  p: CanvasPoint,
  toPx: ToPx,
) {
  const [px, py] = toPx(p.x, p.y);
  // A white rim keeps the dot legible where it lands on top of dark arrows.
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(px, py, 6.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.point;
  ctx.beginPath();
  ctx.arc(px, py, 5.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.font =
    "600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  // A white halo keeps the label readable over dense arrows.
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.strokeText(p.name, px + 9, py - 6);
  ctx.fillStyle = COLORS.point;
  ctx.fillText(p.name, px + 9, py - 6);
}

/** Handles: white dots with a dark rim, ringed when selected. */
function drawHandles(
  ctx: CanvasRenderingContext2D,
  handles: Handle[],
  selected: string | null,
  toPx: ToPx,
) {
  for (const h of handles) {
    if (h.id !== selected) continue; // an unselected point is already drawn
    const [px, py] = toPx(h.x, h.y);
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = COLORS.handle;
    ctx.beginPath();
    ctx.arc(px, py, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ux: number,
  uy: number,
  color: string,
  size: number,
) {
  const spread = 0.44;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x - size * (ux * Math.cos(spread) - uy * Math.sin(spread)),
    y - size * (uy * Math.cos(spread) + ux * Math.sin(spread)),
  );
  ctx.lineTo(
    x - size * (ux * Math.cos(-spread) - uy * Math.sin(-spread)),
    y - size * (uy * Math.cos(-spread) + ux * Math.sin(-spread)),
  );
  ctx.closePath();
  ctx.fill();
}
