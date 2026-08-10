/**
 * The expression list: one editable row per object in the document.
 *
 * Desmos-style in feel — type and it works, everything live, per-row visibility.
 * Results under a row are **short computed values only**, never sentences
 * (PRD §9): `div 0`, `curl 2`, `length 6.2832`. Every control is reachable and
 * operable by keyboard.
 */

import { useEffect, useState } from "react";
import { ROW_COLOR } from "../colors";
import {
  bound,
  type CurveRow,
  type FieldRow,
  type PointRow,
  type Row,
  type RowId,
  type RowKind,
  type RowResult,
  type SliderRow,
} from "../rows";

interface Props {
  rows: Row[];
  results: Map<RowId, RowResult>;
  onChange: (id: RowId, patch: Partial<Row>) => void;
  onRemove: (id: RowId) => void;
}

/**
 * Parse a number, or NaN when the text isn't one *yet*.
 *
 * "-", ".", "-." and "" are all legitimate halfway states while typing a
 * negative or a decimal. Returning a fallback for them is what made the point
 * inputs impossible to type into: the value snapped back on the first keystroke,
 * so a minus sign or a decimal point could never survive long enough to be
 * followed by digits. NumInput below keeps the raw text until it parses.
 */
function parseNum(s: string): number {
  const t = s.trim().replace(/−/g, "-");
  if (t === "" || t === "-" || t === "." || t === "-." || t === "+") return NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

const round = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * A numeric field that can be typed into *and* driven from outside.
 *
 * It holds the raw text while you type, committing only when it parses — so
 * "-", "0.", and "-." are all fine intermediate states. When the value changes
 * from elsewhere (dragging the point on the canvas) that supersedes the draft,
 * which is what keeps the row and the dot in sync during a drag.
 */
function NumInput({
  value,
  onCommit,
  ariaLabel,
  className = "cell cell-num",
}: {
  value: number;
  onCommit: (n: number) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    // Keep the draft only while it still describes the current value — so
    // "2.50" isn't rewritten to "2.5" under the cursor, but a drag wins.
    setDraft((d) => (d !== null && parseNum(d) !== value ? null : d));
  }, [value]);

  return (
    <input
      className={className}
      value={draft ?? String(round(value))}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const n = parseNum(text);
        if (!Number.isNaN(n)) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
      aria-label={ariaLabel}
      inputMode="decimal"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

export default function RowList({ rows, results, onChange, onRemove }: Props) {
  return (
    <ul className="row-list">
      {rows.map((row, i) => {
        const res = results.get(row.id);
        return (
          <li key={row.id} className={`row row-${row.kind}`} data-tour-kind={row.kind}>
            {/* Numbered gutter, as in Warp — it gives every row a stable handle
                to refer to, which matters most when a scene is being described
                to someone else. */}
            <span className="row-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="row-body">
              {row.kind === "field" && (
                <FieldRowView row={row} onChange={onChange} />
              )}
              {row.kind === "point" && (
                <PointRowView row={row} onChange={onChange} />
              )}
              {row.kind === "curve" && (
                <CurveRowView row={row} onChange={onChange} />
              )}
              {row.kind === "slider" && (
                <SliderRowView row={row} onChange={onChange} />
              )}

              {res?.error && <div className="row-error">{res.error}</div>}
              {res?.lines?.map((l, k) => (
                <div className="row-line" key={k}>
                  {l}
                </div>
              ))}
            </div>
            <button
              className="row-remove"
              onClick={() => onRemove(row.id)}
              aria-label={`Remove ${row.name}`}
              title={`Remove ${row.name}`}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The visibility dot, tinted to match what the row draws — navy for a field,
 * green for a point, orange for a curve. The *state* is still carried by fill
 * vs. hollow rather than by colour, so it survives any colour vision (§8.4);
 * the tint is there to connect the row to its mark on the graph.
 */
function Dot({
  shown,
  label,
  kind,
  onClick,
}: {
  shown: boolean;
  label: string;
  kind: RowKind;
  onClick: () => void;
}) {
  const color = ROW_COLOR[kind] ?? "var(--ink-faint)";
  return (
    <button
      className={`dot ${shown ? "dot-on" : "dot-off"}`}
      data-tour="dot"
      style={
        shown
          ? { background: color, borderColor: color }
          : { background: "#fff", borderColor: color }
      }
      onClick={onClick}
      aria-label={`${label} ${shown ? "shown" : "hidden"}`}
      title={shown ? "Shown" : "Hidden"}
    />
  );
}

function FieldRowView({
  row,
  onChange,
}: {
  row: FieldRow;
  onChange: Props["onChange"];
}) {
  const setCell = (i: 0 | 1, v: string) => {
    const cells: [string, string] = [...row.cells] as [string, string];
    cells[i] = v;
    onChange(row.id, { cells });
  };
  return (
    <div className="row-main">
      <Dot
        shown={row.shown}
        label={`Field ${row.name}`}
        kind="field"
        onClick={() => onChange(row.id, { shown: !row.shown })}
      />
      <span className="row-name">{row.name}</span>
      <span className="row-sep">=</span>
      <span className="paren">(</span>
      <input
        className="cell"
        value={row.cells[0]}
        onChange={(e) => setCell(0, e.target.value)}
        placeholder="P"
        aria-label={`${row.name} x-component`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="comma">,</span>
      <input
        className="cell"
        value={row.cells[1]}
        onChange={(e) => setCell(1, e.target.value)}
        placeholder="Q"
        aria-label={`${row.name} y-component`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="paren">)</span>
    </div>
  );
}

/**
 * Desmos-style point UI: the coordinates are editable text *and* they track the
 * drag. Typing moves the dot; dragging the dot retypes the numbers.
 *
 * They're text rather than numbers, like every other cell in the document, so a
 * fresh row is genuinely blank and `p = (a, 0)` works — a slider can drive a
 * point.
 */
function PointRowView({
  row,
  onChange,
}: {
  row: PointRow;
  onChange: Props["onChange"];
}) {
  const setCell = (i: 0 | 1, v: string) => {
    const cells: [string, string] = [...row.cells] as [string, string];
    cells[i] = v;
    onChange(row.id, { cells });
  };
  return (
    <div className="row-main">
      <Dot
        shown={row.shown}
        label={`Point ${row.name}`}
        kind="point"
        onClick={() => onChange(row.id, { shown: !row.shown })}
      />
      <span className="row-name">{row.name}</span>
      <span className="row-sep">=</span>
      <span className="paren">(</span>
      <input
        className="cell cell-num"
        value={row.cells[0]}
        onChange={(e) => setCell(0, e.target.value)}
        placeholder="x"
        aria-label={`${row.name} x coordinate`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="comma">,</span>
      <input
        className="cell cell-num"
        value={row.cells[1]}
        onChange={(e) => setCell(1, e.target.value)}
        placeholder="y"
        aria-label={`${row.name} y coordinate`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="paren">)</span>
    </div>
  );
}

function CurveRowView({
  row,
  onChange,
}: {
  row: CurveRow;
  onChange: Props["onChange"];
}) {
  const setCell = (i: 0 | 1, v: string) => {
    const cells: [string, string] = [...row.cells] as [string, string];
    cells[i] = v;
    onChange(row.id, { cells });
  };
  return (
    <>
      <div className="row-main">
        <Dot
          shown={row.shown}
          label={`Curve ${row.name}`}
          kind="curve"
          onClick={() => onChange(row.id, { shown: !row.shown })}
        />
        <span className="row-name">{row.name}</span>
        <span className="row-sub-name">(t)</span>
        <span className="row-sep">=</span>
        <span className="paren">(</span>
        <input
          className="cell"
          value={row.cells[0]}
          onChange={(e) => setCell(0, e.target.value)}
          placeholder="cos(t)"
          aria-label={`${row.name} x of t`}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="comma">,</span>
        <input
          className="cell"
          value={row.cells[1]}
          onChange={(e) => setCell(1, e.target.value)}
          placeholder="sin(t)"
          aria-label={`${row.name} y of t`}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="paren">)</span>
      </div>
      <div className="row-sub">
        <span className="tiny-label">t from</span>
        <input
          className="cell cell-num"
          value={row.t0}
          onChange={(e) => onChange(row.id, { t0: e.target.value })}
          aria-label={`${row.name} t start`}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="tiny-label">to</span>
        <input
          className="cell cell-num"
          value={row.t1}
          onChange={(e) => onChange(row.id, { t1: e.target.value })}
          aria-label={`${row.name} t end`}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </>
  );
}

function SliderRowView({
  row,
  onChange,
}: {
  row: SliderRow;
  onChange: Props["onChange"];
}) {
  const lo = bound(row.min, -5);
  const hi = bound(row.max, 5);
  return (
    <>
      <div className="row-main">
        <span className="row-name">{row.name}</span>
        <span className="row-sep">=</span>
        <NumInput
          value={row.value}
          onCommit={(value) => onChange(row.id, { value })}
          ariaLabel={`${row.name} value`}
        />
      </div>
      <div className="slider-row">
        <input
          className="bound"
          value={row.min}
          onChange={(e) => onChange(row.id, { min: e.target.value })}
          aria-label={`${row.name} minimum`}
          spellCheck={false}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={(hi - lo) / 400 || 0.01}
          value={row.value}
          onChange={(e) => onChange(row.id, { value: Number(e.target.value) })}
          aria-label={`${row.name} slider`}
        />
        <input
          className="bound"
          value={row.max}
          onChange={(e) => onChange(row.id, { max: e.target.value })}
          aria-label={`${row.name} maximum`}
          spellCheck={false}
        />
      </div>
    </>
  );
}
