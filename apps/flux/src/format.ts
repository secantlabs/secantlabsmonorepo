/**
 * Value → display text. Never implies more precision than the computation
 * earned, and never shows −0 or floating-point noise.
 */

/** A number for inline display: up to 4 significant decimals, trimmed. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : Number.isNaN(n) ? "—" : "−∞";
  if (n === 0) return "0";
  const r = Math.round(n * 1e6) / 1e6;
  // A value that rounds away entirely is 0, not "0.000e+0". This matters more
  // than it looks: div and curl of an exactly-divergence-free field land on
  // float dust like 5e−17, and printing that in scientific notation reads as a
  // real measurement rather than as zero.
  if (r === 0) return "0";
  const abs = Math.abs(r);
  if (abs >= 1e6 || abs < 1e-4) return r.toExponential(3).replace("-", "−");
  const s = (Math.round(r * 1e4) / 1e4).toString();
  return s.replace("-", "−");
}

/**
 * A quadrature result, shown to the precision its own error estimate supports.
 * Printing 3.41772589 when the error bar is 1e-3 would be a lie about how much
 * the computation knows.
 */
export function fmtQuad(value: number, error: number): string {
  if (!Number.isFinite(value)) return fmt(value);
  const digits =
    !Number.isFinite(error) || error <= 0
      ? 6
      : Math.max(0, Math.min(9, Math.floor(-Math.log10(Math.abs(error))) + 1));
  const s = value.toFixed(digits);
  const trimmed = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return (Object.is(Number(trimmed), -0) ? "0" : trimmed).replace("-", "−");
}

/** An error magnitude, always in exponential form so it reads as a bound. */
export function fmtError(error: number): string {
  if (!Number.isFinite(error)) return "—";
  if (error === 0) return "0";
  return error.toExponential(1).replace("-", "−").replace("e", "e");
}

/**
 * A signed number with an explicit + on positives — for div/curl, where the
 * sign *is* the reading (source vs. sink, counter-clockwise vs. clockwise).
 * A value that rounds to zero gets no sign: "+0" claims a direction that the
 * number doesn't have.
 */
export function fmtSigned(n: number): string {
  if (!Number.isFinite(n)) return fmt(n);
  const s = fmt(n);
  if (s === "0") return "0";
  return n > 0 ? `+${s}` : s;
}

/** Degrees from radians, for direction readouts. */
export function fmtAngle(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  return `${fmt(Math.round(deg * 10) / 10)}°`;
}
