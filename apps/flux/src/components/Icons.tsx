/**
 * The header icons, matching Warp's: thin single-stroke glyphs at 16px, drawn
 * rather than typed so they line up with each other instead of inheriting a
 * font's own idea of where a character sits.
 */

const S = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** The brand mark: a small field of arrows. */
export function FluxMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 13.5 L6.2 10.3 M6.2 10.3 L4.5 10.4 M6.2 10.3 L6.1 12" />
      <path d="M8 15 L8 10.8 M8 10.8 L7 11.8 M8 10.8 L9 11.8" />
      <path d="M13 13.5 L9.8 10.3 M9.8 10.3 L11.5 10.4 M9.8 10.3 L9.9 12" />
      <path d="M3.5 7 L7.6 5.6 M7.6 5.6 L6.3 4.9 M7.6 5.6 L6.6 6.7" />
      <path d="M12.5 7 L8.4 5.6 M8.4 5.6 L9.7 4.9 M8.4 5.6 L9.4 6.7" />
    </svg>
  );
}

/** Recentre the view. */
export const IconRecenter = () => (
  <svg {...S}>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8" />
  </svg>
);

/** Copy a link to this scene. */
export const IconShare = () => (
  <svg {...S}>
    <rect x="5.6" y="5.6" width="8" height="8" rx="1.6" />
    <path d="M10.4 3.4H4a1.6 1.6 0 0 0-1.6 1.6v6.4" />
  </svg>
);

export const IconPlus = () => (
  <svg {...S}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </svg>
);

/** Undo: a counter-clockwise arrow, matching Warp's header pair. */
export const IconUndo = () => (
  <svg {...S}>
    <path d="M3.4 7.2A5 5 0 1 1 8 13.2" />
    <path d="M2.2 4.2v3.2h3.2" />
  </svg>
);

export const IconRedo = () => (
  <svg {...S}>
    <path d="M12.6 7.2A5 5 0 1 0 8 13.2" />
    <path d="M13.8 4.2v3.2h-3.2" />
  </svg>
);

export const IconCheck = () => (
  <svg {...S}>
    <path d="M3 8.4 6.4 12 13 4.8" />
  </svg>
);
