/**
 * A "ghost" onboarding tour, matching Warp's: dims the app, spotlights one piece
 * of UI per step, and explains it in a small card beside it.
 *
 * Two details carried over from Warp's implementation because they are what make
 * it feel solid rather than fiddly:
 *
 *   - **The dimming layer *is* the spotlight's box-shadow** (`0 0 0 9999px`), so
 *     the highlighted element stays at full brightness inside the cutout without
 *     needing a mask or four separate scrim rectangles.
 *   - **A step whose target isn't on screen is skipped**, in whichever direction
 *     you were travelling. That means the same tour works over a blank sandbox,
 *     over the starter scene, and over whatever the visitor has already built —
 *     no step ever points at nothing.
 *
 * Step text is a function of the live document, so it never claims the field is
 * something it isn't.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

/** What the steps are allowed to say about the current scene. */
export interface TourContext {
  /** The active field's name and component text, if there is one. */
  field: { name: string; x: string; y: string } | null;
  hasPoint: boolean;
  hasCurve: boolean;
}

interface Step {
  /** CSS selector for the element to spotlight; omitted = centred card. */
  target?: string;
  title: string;
  body: (ctx: TourContext) => string;
}

/** "(−y, x)" for the real components, or a neutral phrase when it's empty. */
function fieldPhrase(ctx: TourContext): string {
  const f = ctx.field;
  if (!f) return "";
  const x = f.x.trim();
  const y = f.y.trim();
  if (!x && !y) return "";
  return `(${x || "0"}, ${y || "0"})`;
}

const STEPS: Step[] = [
  {
    title: "Welcome to Flux",
    body: () =>
      "Flux plots vector fields: every point of the plane gets an arrow. " +
      "Type almost any field and see it immediately — including the ones that " +
      "misbehave. Here's a short tour of the essentials.",
  },
  {
    target: '[data-tour-kind="field"]',
    title: "A field is two components",
    body: (ctx) => {
      const p = fieldPhrase(ctx);
      const name = ctx.field?.name ?? "F";
      const which = p
        ? `${name} is ${p} right now — edit either component`
        : `Type into either cell`;
      return (
        `${which} and every arrow updates as you type. The two cells are the ` +
        `Cartesian components: the î part and the ĵ part. ` +
        `sin, cos, exp, ln, sqrt and division all work, so 1/r² fields are fair game.`
      );
    },
  },
  {
    target: '[data-tour="dot"]',
    title: "Show and hide",
    body: () =>
      "Each dot toggles its row on the graph, Desmos-style, and it's tinted to " +
      "match what that row draws — navy for a field, green for a point, orange " +
      "for a curve.",
  },
  {
    target: '[data-tour-kind="point"]',
    title: "A point you can drag",
    body: () =>
      "Drag the dot on the graph and these coordinates follow; type coordinates " +
      "and the dot moves. They're ordinary cells, so a slider can drive one — " +
      "try p = (a, 0).",
  },
  {
    target: '[data-tour-kind="curve"]',
    title: "A curve from r(t)",
    body: () =>
      "Give x(t) and y(t) and an interval, and Flux draws the path with its " +
      "direction marked. Change the interval to sweep only part of it.",
  },
  {
    target: '[data-tour="add"]',
    title: "Build your scene",
    body: () =>
      "Add fields, points, curves and sliders here. New rows come in blank — " +
      "nothing appears on the graph until you type it.",
  },
  {
    target: '[data-tour="share"]',
    title: "Share and undo",
    body: () =>
      "Your whole scene lives in the URL, and this button copies a link that " +
      "recreates it exactly. ⌘Z undoes any step. Rerun this tour any time from " +
      "the Tutorial button, top right of the graph.",
  },
];

const PAD = 6; // spotlight breathing room around the target
const CARD_W = 300;

function findVisible(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export default function Tour({
  ctx,
  onClose,
}: {
  ctx: TourContext;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dir = useRef(1); // which way to skip past a missing target
  const cardRef = useRef<HTMLDivElement>(null);

  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const go = (d: number) => {
    dir.current = d;
    const next = i + d;
    if (next >= STEPS.length) onClose();
    else if (next >= 0) setI(next);
  };

  // Measure the target; skip steps whose target isn't on screen.
  useEffect(() => {
    if (!step.target) {
      setRect(null);
      return;
    }
    const el = findVisible(step.target);
    if (!el) {
      const next = i + dir.current;
      if (next < 0 || next >= STEPS.length) onClose();
      else setI(next);
      return;
    }
    el.scrollIntoView({ block: "nearest" });
    const measure = () => setRect(el.getBoundingClientRect());
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Focus the card so a screen reader announces each step and the buttons are
  // immediately reachable.
  useEffect(() => {
    cardRef.current?.focus();
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const spot: CSSProperties = rect
    ? {
        left: rect.left - PAD,
        top: rect.top - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : { left: "50%", top: "50%", width: 0, height: 0 };

  const card: CSSProperties = (() => {
    if (!rect)
      return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + PAD + 14;
    if (left + CARD_W > vw - 8)
      left = Math.max(8, rect.left - PAD - 14 - CARD_W);
    const top = Math.min(Math.max(8, rect.top - PAD), Math.max(8, vh - 240));
    return { left, top };
  })();

  return (
    <div className="tour">
      <div className="tour-blocker" />
      <div className="tour-spotlight" style={spot} />
      <div
        className="tour-card"
        style={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        tabIndex={-1}
        ref={cardRef}
      >
        <button className="tour-close" title="Skip the tour" onClick={onClose}>
          ×
        </button>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body(ctx)}</p>
        <div className="tour-nav">
          <span className="tour-count">
            {i + 1} / {STEPS.length}
          </span>
          {i > 0 && (
            <button className="tour-btn ghost" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button className="tour-btn primary" onClick={() => go(1)}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
