/**
 * Flux — the shell.
 *
 * v0.2 (PRD §1): the draw is "plot almost any vector field, easily", supported by
 * a draggable point and a parameterized curve. Short computed results, no
 * on-screen exposition (§9). Everything keyboard-operable (§8.2).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FieldCanvas, {
  type CanvasCurve,
  type CanvasField,
  type CanvasPoint,
} from "./components/FieldCanvas";
import RowList from "./components/RowList";
import SidebarHeader from "./components/SidebarHeader";
import Tour, { type TourContext } from "./components/Tour";
import { collectHandles, moveHandle, nudgeRow, type Handle } from "./handles";
import { useRowHistory } from "./history";
import { describeScene } from "./narrate";
import {
  DEFAULT_VIEW,
  loadInitialState,
  markTourSeen,
  saveState,
  starterDoc,
  type Doc,
  type View,
} from "./persist";
import {
  activeFieldName,
  curveResult,
  fieldResult,
  newCurve,
  newField,
  newPoint,
  newSlider,
  pointResult,
  resolve,
  type Row,
  type RowId,
  type RowKind,
  type RowResult,
} from "./rows";

const initial = loadInitialState();

/** Long enough that a pan or zoom gesture writes once, short enough to feel instant. */
const SAVE_DEBOUNCE_MS = 350;

export default function App() {
  const [doc, setDoc] = useState<Doc>(initial.doc);
  const [staleLink] = useState(initial.staleLink);
  const [tourOpen, setTourOpen] = useState(initial.showTour);
  const [copied, setCopied] = useState(false);
  const [unplottable, setUnplottable] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Persistence is debounced, and that is a correctness fix rather than a
   * micro-optimisation. The view lives in the document, so an immediate save ran
   * on every wheel tick of a zoom — and `saveState` calls `history.replaceState`,
   * which WebKit caps at ~100 calls per 30 seconds before throwing. About a
   * second of continuous zooming exhausted the budget, and with no error boundary
   * the throw unmounted the app: a blank page mid-gesture.
   *
   * A gesture settles long before this delay matters to anyone, and the address
   * bar has no reason to be correct halfway through a zoom.
   */
  useEffect(() => {
    const t = setTimeout(() => saveState(doc), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [doc]);

  /**
   * ...but a debounce means the last change is still pending when a tab closes,
   * so flush on the way out. `pagehide` fires where `beforeunload` is unreliable
   * (iOS Safari especially).
   */
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    const flush = () => saveState(docRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const restoreRows = useCallback((rows: Row[]) => {
    setDoc((d) => ({ ...d, rows, selected: null }));
  }, []);
  const history = useRowHistory(doc.rows, restoreRows);

  const onChange = useCallback((id: RowId, patch: Partial<Row>) => {
    setDoc((d) => ({
      ...d,
      rows: d.rows.map((r) => (r.id === id ? ({ ...r, ...patch } as Row) : r)),
    }));
  }, []);

  const onRemove = useCallback((id: RowId) => {
    setDoc((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== id) }));
  }, []);

  const onAdd = useCallback((kind: RowKind) => {
    setDoc((d) => {
      const make: Record<RowKind, (rows: Row[]) => Row> = {
        field: newField,
        point: newPoint,
        curve: newCurve,
        slider: newSlider,
      };
      return { ...d, rows: [...d.rows, make[kind](d.rows)] };
    });
  }, []);

  const onViewChange = useCallback((view: View) => {
    setDoc((d) => ({ ...d, view }));
  }, []);

  const onSelect = useCallback((handleId: string | null) => {
    setDoc((d) => (d.selected === handleId ? d : { ...d, selected: handleId }));
  }, []);

  /**
   * Both handle paths funnel through one updater, so the row's *current* value is
   * always the basis for the patch. That is what lets keyboard nudges compose
   * when they arrive faster than a re-render.
   */
  const patchHandleRow = useCallback(
    (rowId: RowId, make: (row: Row) => Partial<Row> | null) => {
      setDoc((d) => {
        const row = d.rows.find((r) => r.id === rowId);
        if (!row) return d;
        const patch = make(row);
        if (!patch) return d;
        return {
          ...d,
          rows: d.rows.map((r) =>
            r.id === rowId ? ({ ...r, ...patch } as Row) : r,
          ),
        };
      });
    },
    [],
  );

  const onHandleMove = useCallback(
    (h: Handle, x: number, y: number) =>
      patchHandleRow(h.rowId, (row) => moveHandle(row, x, y)),
    [patchHandleRow],
  );

  const onHandleNudge = useCallback(
    (h: Handle, dx: number, dy: number) =>
      patchHandleRow(h.rowId, (row) => nudgeRow(row, dx, dy)),
    [patchHandleRow],
  );

  const resolved = useMemo(() => resolve(doc.rows), [doc.rows]);
  const handles = useMemo(
    () => collectHandles(doc.rows, resolved.points),
    [doc.rows, resolved.points],
  );

  const fieldName = useMemo(
    () => activeFieldName(doc.rows, resolved.fields),
    [doc.rows, resolved.fields],
  );
  const F = fieldName ? resolved.fields.get(fieldName) ?? null : null;

  const results = useMemo(() => {
    const out = new Map<RowId, RowResult>();
    for (const r of doc.rows) {
      const err = resolved.errors.get(r.id);
      if (err) {
        out.set(r.id, { error: err });
        continue;
      }
      if (r.kind === "field") {
        const f = resolved.fields.get(r.name);
        if (f) out.set(r.id, fieldResult(f, resolved.scope));
      } else if (r.kind === "point") {
        const p = resolved.points.get(r.id);
        if (p)
          out.set(r.id, pointResult(F, fieldName, p.x, p.y, resolved.scope));
      } else if (r.kind === "curve") {
        const rc = resolved.curves.get(r.name);
        if (rc) out.set(r.id, curveResult(rc));
      }
    }
    return out;
  }, [doc.rows, resolved, F, fieldName]);

  const canvasFields = useMemo<CanvasField[]>(() => {
    const out: CanvasField[] = [];
    for (const r of doc.rows) {
      if (r.kind !== "field" || !r.shown) continue;
      const f = resolved.fields.get(r.name);
      if (f) out.push({ name: r.name, F: f });
    }
    return out;
  }, [doc.rows, resolved.fields]);

  const canvasCurves = useMemo<CanvasCurve[]>(() => {
    const out: CanvasCurve[] = [];
    for (const r of doc.rows) {
      if (r.kind !== "curve" || !r.shown) continue;
      const rc = resolved.curves.get(r.name);
      if (rc) out.push({ name: r.name, points: rc.points, closed: rc.closed });
    }
    return out;
  }, [doc.rows, resolved.curves]);

  const canvasPoints = useMemo<CanvasPoint[]>(() => {
    const out: CanvasPoint[] = [];
    for (const r of doc.rows) {
      if (r.kind !== "point" || !r.shown) continue;
      const p = resolved.points.get(r.id);
      if (p) out.push({ name: p.name, x: p.x, y: p.y });
    }
    return out;
  }, [doc.rows, resolved.points]);

  /**
   * The canvas's screen-reader label. A canvas of arrows is otherwise announced
   * as "graphic", which is useless — so one concise sentence. Deliberately not
   * shown on screen: the visible narration layer belongs to the paid bundle
   * (PRD §9).
   */
  const description = useMemo(() => {
    const { cx, cy, scale } = doc.view;
    const halfW = 420 / scale;
    const halfH = 300 / scale;
    return describeScene({
      fields: canvasFields,
      points: canvasPoints,
      curves: canvasCurves,
      scope: resolved.scope,
      window: { x0: cx - halfW, x1: cx + halfW, y0: cy - halfH, y1: cy + halfH },
    });
  }, [canvasFields, canvasPoints, canvasCurves, resolved.scope, doc.view]);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked; the address bar already holds the scene
    }
  };

  /** What the tour is allowed to say about the scene, so it never misdescribes it. */
  const tourContext = useMemo<TourContext>(() => {
    const fieldRow = doc.rows.find(
      (r): r is Extract<Row, { kind: "field" }> =>
        r.kind === "field" && r.name === fieldName,
    );
    return {
      field: fieldRow
        ? { name: fieldRow.name, x: fieldRow.cells[0], y: fieldRow.cells[1] }
        : null,
      hasPoint: doc.rows.some((r) => r.kind === "point"),
      hasCurve: doc.rows.some((r) => r.kind === "curve"),
    };
  }, [doc.rows, fieldName]);

  /**
   * Opening the tour over an empty sandbox seeds the starter scene, as Warp
   * does — a spotlight tour with nothing to spotlight teaches nothing. An
   * existing scene is left exactly as it is.
   */
  const openTour = useCallback(() => {
    setDoc((d) => (d.rows.length === 0 ? { ...d, rows: starterDoc().rows } : d));
    setTourOpen(true);
  }, []);

  const closeTour = useCallback(() => {
    setTourOpen(false);
    markTourSeen();
  }, []);

  return (
    <div className="app">
      {staleLink && (
        <div className="banner" role="status">
          That link was made by a different version of Flux, so it couldn't be
          opened. Showing the starter scene instead.
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <SidebarHeader
            onAdd={onAdd}
            onRecenter={() => onViewChange({ ...DEFAULT_VIEW })}
            onShare={share}
            copied={copied}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onUndo={history.undo}
            onRedo={history.redo}
          />
          <div className="rows-scroll">
            <RowList
              rows={doc.rows}
              results={results}
              onChange={onChange}
              onRemove={onRemove}
            />
            {doc.rows.length === 0 && (
              <p className="rows-empty">
                Press <strong>+</strong> to add a field. Try{" "}
                <code>(−y, x)</code>, or <code>x/(x^2+y^2)</code> and{" "}
                <code>y/(x^2+y^2)</code>.
              </p>
            )}
          </div>
          <div className="side-foot">
            <p className="foot-hint">Drag to pan · scroll to zoom</p>
            <p className="foot-hint foot-keys">
              <kbd>Tab</kbd> selects a point · arrows move it · <kbd>0</kbd>{" "}
              recentres
            </p>
            {doc.rows.length > 0 && (
              <button
                className="link-btn"
                onClick={() => setDoc((d) => ({ ...d, rows: [], selected: null }))}
              >
                Clear all
              </button>
            )}
          </div>
        </aside>

        <main className="stage">
          <FieldCanvas
            fields={canvasFields}
            curves={canvasCurves}
            points={canvasPoints}
            handles={handles}
            selected={doc.selected}
            scope={resolved.scope}
            view={doc.view}
            description={description}
            onViewChange={onViewChange}
            onHandleMove={onHandleMove}
            onHandleNudge={onHandleNudge}
            onSelect={onSelect}
            onUnplottable={setUnplottable}
            focusRef={canvasRef}
          />
          {/* Desmos-style: the graph says when it couldn't draw everything.
              Load-bearing rather than decorative — arrows past double range are
              left out entirely, and an unexplained gap reads as "the field is
              zero here", which is the very thing the singular marker exists to
              prevent. It clears itself as soon as you pan back. */}
          {unplottable && (
            <div className="graph-notice" role="status">
              <span aria-hidden="true">⚠</span> Some values are too large to
              plot — those arrows aren&rsquo;t drawn.
            </div>
          )}
          {/* Floating over the canvas, as Warp does it — chrome that belongs to
              the tool rather than to the graph stays off the sidebar. */}
          <div className="stage-actions">
            <button className="pill" onClick={openTour}>
              Tutorial
            </button>
          </div>
        </main>
      </div>

      {tourOpen && <Tour ctx={tourContext} onClose={closeTour} />}
    </div>
  );
}
