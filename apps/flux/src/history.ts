/**
 * Undo / redo over the row list.
 *
 * Three design decisions worth stating, because each is easy to get wrong:
 *
 * **History records rows, not the whole document.** Panning and zooming change
 * `view`, and folding those in would mean ⌘Z scrolls the graph back instead of
 * undoing the edit you just made — which is maddening, and is why Warp keeps its
 * history per-document rather than per-viewport.
 *
 * **Changes are observed, not reported.** The hook watches the committed rows
 * rather than asking every call site to announce itself. That matters because
 * handle drags and keyboard nudges must keep using React's functional updater to
 * stay correct under fast input (see `nudgeRow`), so they cannot also hand a
 * "previous value" to a history API. Observing the real sequence of committed
 * states is robust regardless of how each change was made.
 *
 * **Coalescing keys on *what* changed, not only on elapsed time.** Consecutive
 * edits to the same row are one undo step; anything structural — adding,
 * removing, or touching a different row — always starts a new one. An earlier
 * version used a short wall-clock window alone and quietly failed: the gap it
 * measured was between *effect runs*, which on a busy main thread ran 150ms to
 * 1000ms apart for single keystrokes, so every character became its own undo.
 * Tying the burst to the edited row makes the granularity depend on user intent
 * rather than on frame timing, with a generous time window only to separate
 * deliberate pauses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type Row } from "./rows";

/**
 * Returning to the same cell after this long starts a fresh undo step.
 * Deliberately generous — it exists to separate "I came back to this later"
 * from "I am still typing", not to time individual keystrokes.
 */
const COALESCE_MS = 1500;
/** Plenty for a sandbox session, and bounded so a long session can't grow forever. */
const LIMIT = 120;

export interface History {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/**
 * The id of the single row that changed, or null when the change was structural
 * — a different length, a reorder, or more than one row at once. A structural
 * change always deserves its own undo step.
 */
function singleEditedRow(prev: Row[], next: Row[]): string | null {
  if (prev.length !== next.length) return null;
  let changed: string | null = null;
  for (let i = 0; i < next.length; i++) {
    if (prev[i].id !== next[i].id) return null;
    if (prev[i] !== next[i]) {
      if (changed !== null) return null;
      changed = next[i].id;
    }
  }
  return changed;
}

export function useRowHistory(
  rows: Row[],
  restore: (rows: Row[]) => void,
): History {
  const past = useRef<Row[][]>([]);
  const future = useRef<Row[][]>([]);
  /** The last rows we've accounted for — what an undo would push forward. */
  const committed = useRef(rows);
  const lastEditedRow = useRef<string | null>(null);
  const lastChangeAt = useRef(0);
  /** Set while applying an undo/redo, so it isn't recorded as a fresh edit. */
  const traveling = useRef(false);
  const [, bump] = useState(0);

  useEffect(() => {
    if (rows === committed.current) return;

    if (traveling.current) {
      traveling.current = false;
      committed.current = rows;
      lastEditedRow.current = null;
      bump((v) => v + 1);
      return;
    }

    const now = performance.now();
    const editedRow = singleEditedRow(committed.current, rows);
    const sameBurst =
      editedRow !== null &&
      editedRow === lastEditedRow.current &&
      now - lastChangeAt.current < COALESCE_MS &&
      past.current.length > 0;

    if (!sameBurst) {
      // Push the state *before* this edit; that's what undo restores.
      past.current = [...past.current, committed.current].slice(-LIMIT);
    }
    // Any fresh edit invalidates the redo branch, burst or not.
    future.current = [];
    lastChangeAt.current = now;
    lastEditedRow.current = editedRow;
    committed.current = rows;
    bump((v) => v + 1);
  }, [rows]);

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    const target = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [committed.current, ...future.current];
    traveling.current = true;
    // Don't let the next edit coalesce into whatever preceded the time travel.
    lastChangeAt.current = 0;
    lastEditedRow.current = null;
    restore(target);
  }, [restore]);

  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    const [target, ...rest] = future.current;
    future.current = rest;
    past.current = [...past.current, committed.current].slice(-LIMIT);
    traveling.current = true;
    lastChangeAt.current = 0;
    lastEditedRow.current = null;
    restore(target);
  }, [restore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        // Intercepted even inside a text field. Our inputs are controlled, so
        // the browser's native undo can't restore their text anyway — and every
        // keystroke is already a document change, so a document-level undo is
        // what "undo my typing" actually means here.
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undo,
    redo,
  };
}
