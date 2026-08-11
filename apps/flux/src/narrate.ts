/**
 * The screen-reader label for the canvas — and nothing else.
 *
 * An earlier draft had a narration layer: paragraph readouts under every result
 * and a running caption beside the graph. That is now the **paid bundle's**
 * feature, not the free sandbox's (PRD §9). Putting it here made Flux feel heavy
 * and gave away the differentiator the library channel depends on.
 *
 * What survives is the invisible half: a canvas of arrows is otherwise announced
 * as "graphic", which is useless. So one concise sentence — what is plotted, over
 * what window, and whether anything is singular. Short by design; this is a
 * label, not exposition.
 *
 * The habit to keep: **update this in the same commit as anything that changes
 * what's drawn.** One line, not a writing project.
 */

import {
  classifyNonFinite,
  evalField,
  isSingularAt,
  type Field2,
} from "@secantlabs/engine/field";
import { type Scope } from "@secantlabs/engine/elem";
import { fmt } from "./format";

export interface SceneSummary {
  fields: { name: string; F: Field2 }[];
  points: { name: string; x: number; y: number }[];
  curves: { name: string }[];
  scope: Scope;
  window: { x0: number; y0: number; x1: number; y1: number };
}

export function describeScene(s: SceneSummary): string {
  const parts: string[] = [];
  const win = `x from ${fmt(s.window.x0)} to ${fmt(s.window.x1)}, y from ${fmt(
    s.window.y0,
  )} to ${fmt(s.window.y1)}`;

  if (s.fields.length === 0) {
    parts.push(`Empty graph, ${win}. Add a vector field to plot one.`);
  } else {
    for (const f of s.fields) {
      const scan = scanField(f.F, s.scope, s.window);
      parts.push(
        `Vector field ${f.name} over ${win}. ` +
          `Magnitude ${fmt(scan.min)} to ${fmt(scan.max)}.` +
          (scan.singular
            ? ` Undefined in places, marked with open circles.`
            : "") +
          (scan.overflow
            ? ` Some values are too large to plot, so those arrows are left out.`
            : ""),
      );
    }
  }
  for (const p of s.points)
    parts.push(`Point ${p.name} at (${fmt(p.x)}, ${fmt(p.y)}).`);
  if (s.curves.length)
    parts.push(
      `${s.curves.length === 1 ? "Curve" : "Curves"} ${s.curves
        .map((c) => c.name)
        .join(", ")} drawn.`,
    );
  return parts.join(" ");
}

/**
 * A coarse scan: enough for a magnitude range and the two "nothing drawable
 * here" flags. Undefined and too-large-for-a-double are different facts and the
 * canvas marks them differently, so the label distinguishes them too.
 */
function scanField(
  F: Field2,
  scope: Scope,
  w: { x0: number; y0: number; x1: number; y1: number },
): { min: number; max: number; singular: boolean; overflow: boolean } {
  const N = 9;
  let min = Infinity;
  let max = 0;
  let singular = false;
  let overflow = false;
  const probe = Math.max((w.x1 - w.x0) / (N - 1) / 4, 1e-9);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = w.x0 + ((w.x1 - w.x0) * i) / (N - 1);
      const y = w.y0 + ((w.y1 - w.y0) * j) / (N - 1);
      try {
        const v = evalField(F, x, y, scope);
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) {
          if (classifyNonFinite(F, x, y, probe, scope) === "overflow")
            overflow = true;
          else singular = true;
          continue;
        }
        const m = Math.hypot(v.x, v.y);
        min = Math.min(min, m);
        max = Math.max(max, m);
      } catch {
        singular = true;
        continue;
      }
      // A finite value whose partials blow up is still a genuine irregularity.
      if (!singular && isSingularAt(F, x, y, scope)) singular = true;
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max, singular, overflow };
}
