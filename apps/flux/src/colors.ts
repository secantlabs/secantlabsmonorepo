/**
 * Graph colours — the single source of truth.
 *
 * The canvas draws with these and the expression list's visibility dots are
 * tinted from the same values, so a row's dot always matches what that row puts
 * on screen. Keeping two copies is how those quietly drift apart.
 *
 * Chosen so that no meaning rests on hue alone (PRD §8.4): the field's magnitude
 * ramp is a single-hue *lightness* ramp, dots carry shape and a text label as
 * well as colour, and the visibility dot is filled-vs-hollow rather than
 * two colours.
 */

/** Magnitude ramp for field arrows: weak → strong. */
export const FIELD_WEAK_RGB = [176, 190, 210] as const;
export const FIELD_STRONG_RGB = [30, 41, 92] as const;

export const GRAPH = {
  /** The strong end of the arrow ramp — what a field row's dot shows. */
  field: "rgb(30, 41, 92)",
  /** Dark green: clearly distinct from the navy field it sits on top of. */
  point: "#15803d",
  curve: "#c2410c",
  /** Where the field is undefined. */
  singular: "#c74440",
  /** Selection ring on a handle. */
  selected: "#2b3f8f",
} as const;

/** The dot colour for each row kind. Sliders draw nothing, so they get none. */
export const ROW_COLOR: Record<string, string | null> = {
  field: GRAPH.field,
  point: GRAPH.point,
  curve: GRAPH.curve,
  slider: null,
};

export const lerpColor = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): string => {
  const c = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
};
