import { useRef, useState } from "react";
import { parseBinding } from "@secantlabs/engine/expr";
import {
  type Mode,
  type Row,
  type RowId,
  type RowKind,
  type RowResult,
} from "../rows";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Refresh the URL hash with the current state and copy it. */
  onShare: () => void;
  rows: Row[];
  results: Map<RowId, RowResult>;
  colorOf: Map<RowId, string>;
  /** Expression rows whose value is a matrix — they can drive the warp. */
  warpables: Set<RowId>;
  eigenRows: Set<RowId>;
  /** Top-level svd(M) rows — they report σ values and draw the image axes. */
  svdRows: Set<RowId>;
  /** The active warp is showing gridlines only (the middle click-state). */
  gridOnly: boolean;
  /** Expr rows that bind a name to a plain number — they get a slider. */
  sliders: Map<RowId, number>;
  /** Top-level proj(v, w) rows — they get drop-animation controls. */
  projRows: Set<RowId>;
  /** Per-stage labels for composition animations (applied-first first). */
  stageNamesOf: Map<RowId, string[]>;
  activeId: RowId | null;
  t: number;
  playing: boolean;
  onAdd: (kind: RowKind, afterId?: RowId) => void;
  onToggle: (id: RowId) => void;
  onDelete: (id: RowId) => void;
  onRename: (id: RowId, name: string) => void;
  onExprChange: (id: RowId, src: string) => void;
  onSliderBounds: (id: RowId, min: string, max: string) => void;
  onMatrixCell: (id: RowId, index: number, value: string) => void;
  onVectorCell: (id: RowId, index: number, value: string) => void;
  onPlay: (id: RowId) => void;
  onScrub: (id: RowId, value: number) => void;
  /**
   * Move the row at `from` to the insertion slot `to`, indexed against the
   * current list (0 = before the first row, rows.length = after the last).
   */
  onReorder: (from: number, to: number) => void;
}

const PALETTE: { kind: RowKind; label: string }[] = [
  { kind: "matrix", label: "Add matrix" },
  { kind: "vector", label: "Add vector" },
  { kind: "expr", label: "Add expression" },
  { kind: "slider", label: "Add slider" },
];

/**
 * Engine built-ins, inserted into an expression by its gear menu. A few are
 * dimension-specific: `eigen` is 2D-only for now, and the shape primitive is
 * the circle in 2D, the sphere in 3D.
 */
const FUNCTIONS: { label: string; insert: string; only?: Mode }[] = [
  { label: "det( )", insert: "det()" },
  { label: "eigen( )", insert: "eigen()", only: "2d" },
  { label: "svd( )", insert: "svd()" },
  { label: "inv( )", insert: "inv()" },
  { label: "transpose( )", insert: "transpose()" },
  { label: "diag( , ) — a stretch along the axes", insert: "diag(, )", only: "2d" },
  { label: "diag( , , ) — a stretch along the axes", insert: "diag(, , )", only: "3d" },
  { label: "circle( ) — the unit circle", insert: "circle()", only: "2d" },
  { label: "sphere( ) — the unit sphere", insert: "sphere()", only: "3d" },
  { label: "dot( , )", insert: "dot(, )" },
  { label: "cross( , )", insert: "cross(, )" },
  { label: "dot(del, ) — divergence", insert: "dot(del, )" },
  { label: "cross(del, ) — curl", insert: "cross(del, )" },
  { label: "norm( )", insert: "norm()" },
  { label: "proj( , )", insert: "proj(, )" },
];

/** Round a slider position to something readable ("3.7", not "3.70000004"). */
function fmtSlider(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
}

/** ~200 steps across the range, snapped to a clean 1/2/5 × 10ⁿ increment. */
function niceStep(span: number): number {
  const raw = span / 200;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

export default function ExpressionList(props: Props) {
  const {
    mode,
    rows,
    results,
    colorOf,
    warpables,
    eigenRows,
    svdRows,
    gridOnly,
    sliders,
    projRows,
    stageNamesOf,
    activeId,
    t,
    playing,
  } = props;
  const [openGear, setOpenGear] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // --- Drag to reorder, Desmos-style: the row number on the left is the
  // --- handle, so dragging never fights with editing a cell. `dragFrom` is
  // --- the row being carried; `dropAt` is the insertion slot it would land in.
  // The live drag lives in a ref so the handlers never read a stale closure
  // (pointer events can arrive faster than React re-renders); the state
  // mirrors it purely to drive the lifted row and the drop indicator.
  const rowsRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  /** Insertion slot for a pointer at clientY, from the row midpoints. */
  const slotAt = (clientY: number): number => {
    const host = rowsRef.current;
    if (!host) return 0;
    const els = Array.from(host.querySelectorAll<HTMLElement>(".row"));
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return els.length;
  };

  const startDrag = (index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = index;
    setDragFrom(index);
    setDropAt(index);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (dragRef.current === null) return;
    setDropAt(slotAt(e.clientY));
  };
  const endDrag = (e: React.PointerEvent) => {
    const from = dragRef.current;
    dragRef.current = null;
    setDragFrom(null);
    setDropAt(null);
    if (from === null) return;
    const to = slotAt(e.clientY);
    // A no-op move is either slot that leaves the row where it already is.
    if (to !== from && to !== from + 1) props.onReorder(from, to);
  };

  const handleShare = () => {
    props.onShare();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const pick = (kind: RowKind, afterId?: RowId) => {
    props.onAdd(kind, afterId);
    setOpenGear(null);
  };

  const palette = (afterId?: RowId) => (
    <div className="palette">
      {PALETTE.map((p) => (
        <button key={p.kind} className="palette-item" onClick={() => pick(p.kind, afterId)}>
          {p.label}
        </button>
      ))}
    </div>
  );

  const insertFunction = (row: Row & { kind: "expr" }, text: string) => {
    props.onExprChange(row.id, row.src + text);
    setOpenGear(null);
  };

  const functionPalette = (row: Row & { kind: "expr" }) => (
    <div className="palette">
      {FUNCTIONS.filter((f) => !f.only || f.only === mode).map((f) => (
        <button
          key={f.label}
          className="palette-item"
          onClick={() => insertFunction(row, f.insert)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  const gearKey = (id: RowId) => `row:${id}`;

  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="brand-mark">▦</span>
        <h1>Warp</h1>
        <div className="mode-toggle" data-tour="mode">
          {(["2d", "3d"] as Mode[]).map((m) => (
            <button
              key={m}
              className={mode === m ? "on" : ""}
              onClick={() => props.onModeChange(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <button
            className="gear gear-sm"
            title="Undo (⌘Z)"
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            ↺
          </button>
          <button
            className="gear gear-sm"
            title="Redo (⇧⌘Z)"
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            ↻
          </button>
          <button
            className="gear gear-sm"
            data-tour="share"
            title="Copy a shareable link to this graph"
            onClick={handleShare}
          >
            {copied ? "✓" : "⧉"}
          </button>
          <div className="gear-wrap" data-tour="add">
            <button
              className="gear"
              title="Add…"
              onClick={() => setOpenGear(openGear === "header" ? null : "header")}
            >
              +
            </button>
            {openGear === "header" && palette(undefined)}
          </div>
        </div>
      </header>

      <div className="rows" ref={rowsRef}>
        {rows.length === 0 && (
          <p className="empty-hint">Press + to add a matrix or vector.</p>
        )}
        {rows.map((row, i) => {
          const color = colorOf.get(row.id);
          const res = results.get(row.id);
          const isMatrix = row.kind === "matrix";
          const isWarp = isMatrix || warpables.has(row.id);
          const isEigen = eigenRows.has(row.id);
          const isSvd = svdRows.has(row.id);
          const graphable = isWarp || isEigen || isSvd || color !== undefined;
          const shown = isWarp ? activeId === row.id : row.shown;
          return (
            <div
              className={
                "row" +
                (dragFrom === i ? " dragging" : "") +
                (dragFrom !== null && dropAt === i ? " drop-above" : "") +
                (dragFrom !== null && dropAt === rows.length && i === rows.length - 1
                  ? " drop-below"
                  : "")
              }
              key={row.id}
              data-tour-kind={row.kind}
            >
              <div
                className="row-index"
                title="Drag to reorder"
                onPointerDown={startDrag(i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {i + 1}
              </div>
              <div className="row-body">
                <div className="row-top">
                  {graphable ? (
                    <button
                      data-tour="toggle"
                      className={
                        "toggle-dot" +
                        (isWarp ? " matrix" : "") +
                        (isEigen ? " eigen" : "") +
                        (isSvd ? " svd" : "") +
                        (shown ? " on" : "") +
                        (isWarp && shown && gridOnly ? " gridonly" : "")
                      }
                      style={
                        !isWarp && !isEigen && !isSvd && color
                          ? { color }
                          : undefined
                      }
                      title={
                        !isWarp
                          ? shown
                            ? "Hide"
                            : "Show"
                          : !shown
                            ? "Show"
                            : gridOnly
                              ? "Hide"
                              : "Show gridlines only"
                      }
                      aria-pressed={shown}
                      onClick={() => props.onToggle(row.id)}
                    />
                  ) : (
                    <span className="dot dot-empty" />
                  )}

                  {row.kind === "matrix" && (
                    <div className="row-main">
                      <input
                        className="name-input"
                        value={row.name}
                        onChange={(e) => props.onRename(row.id, e.target.value)}
                      />
                      <span className="eq">=</span>
                      <div className="matrix-bracket">
                        <div
                          className={
                            "matrix-grid" + (row.cells.length === 9 ? " dim3" : "")
                          }
                        >
                          {row.cells.map((c, idx) => (
                            <input
                              key={idx}
                              className="matrix-cell"
                              type="text"
                              value={c}
                              onChange={(e) =>
                                props.onMatrixCell(row.id, idx, e.target.value)
                              }
                              onFocus={(e) => e.target.select()}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {row.kind === "vector" && (
                    <div className="row-main">
                      <input
                        className="name-input"
                        value={row.name}
                        onChange={(e) => props.onRename(row.id, e.target.value)}
                      />
                      <span className="eq">=</span>
                      <div className="matrix-bracket">
                        <div className="vector-grid">
                          {row.cells.map((c, idx) => (
                            <input
                              key={idx}
                              className="matrix-cell"
                              type="text"
                              value={c}
                              onChange={(e) =>
                                props.onVectorCell(row.id, idx, e.target.value)
                              }
                              onFocus={(e) => e.target.select()}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {row.kind === "expr" && (
                    <div className="row-main expr-main">
                      <input
                        className="expr-input"
                        type="text"
                        placeholder="e.g. u = M·v, inv(M), dot(v, w)"
                        value={row.src}
                        onChange={(e) => props.onExprChange(row.id, e.target.value)}
                      />
                    </div>
                  )}

                  <div className="row-actions">
                    {row.kind === "expr" && (
                      <div className="gear-wrap">
                        <button
                          className="gear gear-sm"
                          title="Insert a function…"
                          onClick={() =>
                            setOpenGear(
                              openGear === gearKey(row.id) ? null : gearKey(row.id),
                            )
                          }
                        >
                          ⚙
                        </button>
                        {openGear === gearKey(row.id) && functionPalette(row)}
                      </div>
                    )}
                    <button
                      className="del"
                      title="Delete"
                      onClick={() => props.onDelete(row.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>

                {/* Slider for a scalar binding ("a = 1.5") */}
                {row.kind === "expr" &&
                  sliders.has(row.id) &&
                  (() => {
                    const name = parseBinding(row.src)?.name;
                    if (!name) return null;
                    const value = sliders.get(row.id)!;
                    const minStr = row.sliderMin ?? "-10";
                    const maxStr = row.sliderMax ?? "10";
                    const minNum = parseFloat(minStr);
                    const maxNum = parseFloat(maxStr);
                    // The dragged value always stays reachable, even if it
                    // falls outside the typed bounds.
                    const lo = Math.min(Number.isFinite(minNum) ? minNum : -10, value);
                    const hi = Math.max(Number.isFinite(maxNum) ? maxNum : 10, value);
                    const span = hi - lo || 1;
                    return (
                      <div className="slider-row">
                        <input
                          className="slider-bound"
                          type="text"
                          title="Slider minimum"
                          value={minStr}
                          onChange={(e) =>
                            props.onSliderBounds(row.id, e.target.value, maxStr)
                          }
                        />
                        <input
                          className="anim-slider"
                          type="range"
                          min={lo}
                          max={hi}
                          step="any"
                          value={value}
                          onChange={(e) => {
                            // Quantize to a clean grid ourselves so the value
                            // and the thumb never disagree.
                            const st = niceStep(span);
                            const q = Math.round(parseFloat(e.target.value) / st) * st;
                            props.onExprChange(row.id, `${name} = ${fmtSlider(q)}`);
                          }}
                        />
                        <input
                          className="slider-bound"
                          type="text"
                          title="Slider maximum"
                          value={maxStr}
                          onChange={(e) =>
                            props.onSliderBounds(row.id, minStr, e.target.value)
                          }
                        />
                      </div>
                    );
                  })()}

                {/* Animation controls: the active warp source, or a visible
                    projection (which animates the perpendicular drop) */}
                {((isWarp && activeId === row.id) ||
                  (projRows.has(row.id) && shown)) && (
                  <div className="anim" data-tour="anim">
                    <button
                      className="play"
                      onClick={() => props.onPlay(row.id)}
                      title={
                        isWarp
                          ? "Animate identity → matrix"
                          : "Animate the projection"
                      }
                    >
                      {playing && activeId === row.id ? "❚❚" : "▶"}
                    </button>
                    <input
                      className="anim-slider"
                      type="range"
                      min={0}
                      max={1}
                      step={0.001}
                      value={activeId === row.id ? t : 1}
                      onChange={(e) =>
                        props.onScrub(row.id, parseFloat(e.target.value))
                      }
                    />
                    {(() => {
                      // Composition: show which factor is currently applying.
                      const names = stageNamesOf.get(row.id);
                      if (!names || names.length < 2 || t >= 1) return null;
                      const k = Math.min(
                        Math.floor(t * names.length),
                        names.length - 1,
                      );
                      return (
                        <span className="stage-label">
                          applying {names[k]} ({k + 1}/{names.length})
                        </span>
                      );
                    })()}
                  </div>
                )}

                {/* Inline result for expressions */}
                {row.kind === "expr" && res?.text && (
                  <div className="result-line">
                    <span className="result-eq">=</span>
                    <span className="result-value" style={color ? { color } : undefined}>
                      {res.text}
                    </span>
                  </div>
                )}
                {res?.lines?.map((line, li) => (
                    <div className="result-line" key={li}>
                      <span
                        className="result-value"
                        style={line.color ? { color: line.color } : undefined}
                      >
                        {line.text}
                      </span>
                    </div>
                  ))}
                {res?.error && <div className="result-error">{res.error}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="hint">
        {mode === "3d"
          ? "Drag to orbit · scroll to zoom"
          : "Drag to pan · scroll to zoom"}
      </footer>
    </aside>
  );
}
