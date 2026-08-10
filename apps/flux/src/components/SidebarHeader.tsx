/**
 * The sidebar header, matching Warp's: the brand mark and wordmark on the left,
 * a row of borderless icon buttons on the right, and a **+** that expands into
 * the row kinds.
 *
 * Warp puts this inside the sidebar rather than across the whole window, which
 * leaves the graph edge-to-edge — the single biggest reason Warp reads as a
 * graphing tool rather than an app with a graph in it. Flux follows.
 *
 * Warp's bar also carries a 2D/3D toggle, which Flux has no use for yet — that
 * slot is simply absent rather than stubbed.
 */

import { useEffect, useRef, useState } from "react";
import { ROW_COLOR } from "../colors";
import { type RowKind } from "../rows";
import {
  FluxMark,
  IconCheck,
  IconPlus,
  IconRecenter,
  IconRedo,
  IconShare,
  IconUndo,
} from "./Icons";

interface Props {
  onAdd: (kind: RowKind) => void;
  onRecenter: () => void;
  onShare: () => void;
  copied: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const KINDS: { kind: RowKind; label: string; hint: string }[] = [
  { kind: "field", label: "field", hint: "F = (P, Q)" },
  { kind: "point", label: "point", hint: "p = (x, y)" },
  { kind: "curve", label: "curve", hint: "r(t)" },
  { kind: "slider", label: "slider", hint: "a = 1" },
];

export default function SidebarHeader({
  onAdd,
  onRecenter,
  onShare,
  copied,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: Props) {
  return (
    <header className="side-head">
      <div className="brand">
        <span className="brand-mark">
          <FluxMark />
        </span>
        <span className="brand-name">Flux</span>
      </div>
      <div className="head-actions">
        <button
          className="icon-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (⌘Z)"
          aria-label="Undo"
        >
          <IconUndo />
        </button>
        <button
          className="icon-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
        >
          <IconRedo />
        </button>
        <span className="head-div" aria-hidden="true" />
        <button
          className="icon-btn"
          onClick={onRecenter}
          title="Reset the view"
          aria-label="Reset the view"
        >
          <IconRecenter />
        </button>
        <button
          className="icon-btn"
          onClick={onShare}
          title="Copy a link to this scene"
          aria-label="Copy a link to this scene"
          data-tour="share"
        >
          {copied ? <IconCheck /> : <IconShare />}
        </button>
        <AddMenu onAdd={onAdd} />
      </div>
    </header>
  );
}

/**
 * The **+** button and its menu.
 *
 * Closes on Escape, on an outside click, and after a choice. Arrow keys walk the
 * items and focus moves into the menu on open, so it is operable without a
 * pointer — the same rule the canvas handles follow (PRD §8.2).
 */
function AddMenu({ onAdd }: { onAdd: (kind: RowKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();

    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (kind: RowKind) => {
    onAdd(kind);
    setOpen(false);
    buttonRef.current?.focus();
  };

  /** Arrow keys walk the menu; Home/End jump to the ends. */
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      wrapRef.current?.querySelectorAll<HTMLButtonElement>(".add-item") ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    items[next]?.focus();
    e.preventDefault();
  };

  return (
    <div className="add-wrap" ref={wrapRef}>
      <button
        className={`icon-btn${open ? " icon-btn-active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Add a row"
        aria-label="Add a row"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="add"
        ref={buttonRef}
      >
        <IconPlus />
      </button>
      {open && (
        <div className="add-menu" role="menu" onKeyDown={onMenuKey}>
          {KINDS.map((k, i) => (
            <button
              key={k.kind}
              className="add-item"
              role="menuitem"
              onClick={() => choose(k.kind)}
              ref={i === 0 ? firstItemRef : undefined}
            >
              <span
                className="add-swatch"
                style={{ background: ROW_COLOR[k.kind] ?? "transparent" }}
                aria-hidden="true"
              />
              <span className="add-label">{k.label}</span>
              <span className="add-hint">{k.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
