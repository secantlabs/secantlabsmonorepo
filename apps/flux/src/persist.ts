/**
 * The scene as a URL — no backend.
 *
 * The whole document serializes into the URL hash on every change and persists to
 * localStorage, so reloads restore your work and copying the address bar is
 * sharing.
 *
 * Unlike Warp's hash, this format is **versioned from the first commit**:
 *
 *   https://secantlabs.org/flux/#f1=<blob>
 *
 * The `f1` prefix is a public contract, not an implementation detail. It is what
 * makes the eventual scene deck, lesson embeds, LTI-addressable scenes, and a
 * bring-your-own-LLM connector nearly free later — and it means a format change
 * can ship as `f2` without silently breaking saved links. An unrecognized version
 * loads the starter scene and says so rather than showing a mangled one.
 */

import { newId, type Row, type RowId } from "./rows";

export const FORMAT_VERSION = 1;
export const HASH_PREFIX = `#f${FORMAT_VERSION}=`;
export const LS_KEY = "flux:state";
export const TOUR_KEY = "flux:tour-done";

export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export interface Doc {
  rows: Row[];
  view: View;
  /** The handle the keyboard selection is on, if any. */
  selected: string | null;
}

export const DEFAULT_VIEW: View = { cx: 0, cy: 0, scale: 64 };

// Compact wire format: one-letter kinds and keys keep URLs short enough to paste
// into a chat window.
type SavedRow =
  | { k: "F"; n: string; c: [string, string]; sh?: boolean }
  | { k: "p"; n: string; c: [string, string]; sh?: boolean }
  | { k: "C"; n: string; c: [string, string]; t: [string, string]; sh?: boolean }
  | { k: "a"; n: string; val: number; mn: string; mx: string };

interface SavedState {
  v: 1;
  rows: SavedRow[];
  /** [cx, cy, scale] */
  vw?: [number, number, number];
}

// --- base64url that survives unicode (·, ÷, superscripts in sources) --------

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Dragged coordinates carry float noise; 4 decimals keeps URLs short. */
const round = (n: number): number => Math.round(n * 1e4) / 1e4;

function rowToSaved(r: Row): SavedRow {
  switch (r.kind) {
    case "field":
      return {
        k: "F",
        n: r.name,
        c: [r.cells[0], r.cells[1]],
        ...(r.shown ? {} : { sh: false }),
      };
    case "point":
      return {
        k: "p",
        n: r.name,
        c: [r.cells[0], r.cells[1]],
        ...(r.shown ? {} : { sh: false }),
      };
    case "curve":
      return {
        k: "C",
        n: r.name,
        c: [r.cells[0], r.cells[1]],
        t: [r.t0, r.t1],
        ...(r.shown ? {} : { sh: false }),
      };
    case "slider":
      return { k: "a", n: r.name, val: r.value, mn: r.min, mx: r.max };
  }
}

const str = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : fallback;
const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function savedToRow(s: SavedRow): Row | null {
  const id = newId();
  switch (s.k) {
    case "F": {
      const c = Array.isArray(s.c) ? s.c : [];
      return {
        id,
        kind: "field",
        name: str(s.n, "F"),
        cells: [str(c[0], ""), str(c[1], "")],
        shown: s.sh !== false,
      };
    }
    case "p": {
      const c = Array.isArray(s.c) ? s.c : [];
      return {
        id,
        kind: "point",
        name: str(s.n, "p"),
        cells: [str(c[0], ""), str(c[1], "")],
        shown: s.sh !== false,
      };
    }
    case "C": {
      const c = Array.isArray(s.c) ? s.c : [];
      const t = Array.isArray(s.t) ? s.t : [];
      return {
        id,
        kind: "curve",
        name: str(s.n, "C"),
        cells: [str(c[0], "cos(t)"), str(c[1], "sin(t)")],
        t0: str(t[0], "0"),
        t1: str(t[1], "2pi"),
        shown: s.sh !== false,
      };
    }
    case "a":
      return {
        id,
        kind: "slider",
        name: str(s.n, "a"),
        value: numOr(s.val, 1),
        min: str(s.mn, "-5"),
        max: str(s.mx, "5"),
      };
    default:
      return null; // a row kind from a newer build: skip it, keep the rest
  }
}

/**
 * The scene Flux opens with. Not a preset shelf (PRD §6.5) but a seed, so
 * something is on screen before anyone types. The rotational field is the one
 * that most immediately reads as *a field* rather than as arrows.
 */
export function starterDoc(): Doc {
  return {
    rows: [
      { id: newId(), kind: "field", name: "F", cells: ["-y", "x"], shown: true },
      { id: newId(), kind: "point", name: "p", cells: ["2", "1"], shown: true },
    ],
    view: { ...DEFAULT_VIEW },
    selected: null,
  };
}

// --- Public API -------------------------------------------------------------

export function encodeState(doc: Doc): string {
  const state: SavedState = {
    v: 1,
    rows: doc.rows.map(rowToSaved),
    vw: [round(doc.view.cx), round(doc.view.cy), round(doc.view.scale)],
  };
  return b64encode(JSON.stringify(state));
}

export function decodeState(enc: string): Doc | null {
  try {
    const s = JSON.parse(b64decode(enc)) as SavedState;
    if (s.v !== FORMAT_VERSION || !Array.isArray(s.rows)) return null;
    const rows = s.rows.map(savedToRow).filter((r): r is Row => r !== null);
    const vw = Array.isArray(s.vw) ? s.vw : null;
    const view: View = vw
      ? {
          cx: numOr(vw[0], DEFAULT_VIEW.cx),
          cy: numOr(vw[1], DEFAULT_VIEW.cy),
          // A zero or negative scale would make the canvas math degenerate.
          scale: Math.max(4, numOr(vw[2], DEFAULT_VIEW.scale)),
        }
      : { ...DEFAULT_VIEW };
    return { rows, view, selected: null };
  } catch {
    return null;
  }
}

/** Which hash versions this build understands, for a clear message on a miss. */
export function hashVersion(hash: string): number | null {
  const m = /^#f(\d+)=/.exec(hash);
  return m ? Number(m[1]) : null;
}

function tourAlreadySeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    // storage unavailable; the tour will offer itself again next visit
  }
}

/** Initial state: URL hash first, then localStorage, then the starter scene. */
export function loadInitialState(): {
  doc: Doc;
  staleLink: boolean;
  showTour: boolean;
} {
  const seen = tourAlreadySeen();
  const v = hashVersion(window.location.hash);
  if (v !== null) {
    if (v === FORMAT_VERSION) {
      const fromHash = decodeState(window.location.hash.slice(HASH_PREFIX.length));
      // Someone opened a shared scene: show them *that*, not the tour.
      if (fromHash) return { doc: fromHash, staleLink: false, showTour: false };
    }
    return { doc: starterDoc(), staleLink: true, showTour: false };
  }
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      const fromStore = decodeState(stored);
      if (fromStore) return { doc: fromStore, staleLink: false, showTour: false };
    }
  } catch {
    // storage unavailable (private mode etc.)
  }
  return { doc: starterDoc(), staleLink: false, showTour: !seen };
}

export function saveState(doc: Doc): void {
  const enc = encodeState(doc);
  try {
    localStorage.setItem(LS_KEY, enc);
  } catch {
    // storage unavailable; the URL still carries the scene
  }
  history.replaceState(null, "", HASH_PREFIX + enc);
}

export type { RowId };
