# Flux

A sandbox for vector fields: type (almost) any field and see it. Second tool in
the Secant Labs family, after Warp.

Design spec lives outside this repo, in the Obsidian vault:
`_01 Projects/Germinate Internship/Warp/Future/Flux PRD.md`. **This file is the
implementation handoff** — what exists, what's verified, what's open.

## Running it

```bash
npm run dev:flux          # from the repo root → localhost:5180/flux/
npm run build:flux        # typecheck + production build
npm test                  # engine suite (123 tests)
```

**Deployed at [secantlabs.org/flux](https://secantlabs.org/flux/)** as a subpath of
the landing site. The root `build` script builds Flux and copies its `dist` into
`apps/landing/dist/flux`, which is the directory `deploy.yml` already publishes —
so the workflow itself needed no change.

> Flux ships during the Warp freeze because the freeze's constraints don't reach
> it. One Pages site takes one custom domain, and the hazard is a second CNAME
> landing at the `gh-pages` root: `apps/warp/public/CNAME` wants warp.us.com.
> Flux has no CNAME and lives in a subdirectory. The judged SoME URL
> (`toringastich.github.io/warp-lessons/`) and warp.us.com are served by separate
> repos and are untouched. `apps/warp` and `apps/lessons` are still frozen until
> **Aug 31, 2026** — see the monorepo README.

## Scope (v0.2)

The draw is **"plot almost any vector field, easily."** Two supporting features,
and no more: a draggable **point**, and a parameterized **curve** `r(t)` over an
interval. Four row types: `field`, `point`, `curve`, `slider`.

Regions, line and area integrals, and the **Theorem Bar** — both sides of Green's
theorem live, which was v0.1's signature feature — are **shelved, not cancelled**
(PRD §13). Their engine survives, tested, so unshelving is mostly UI work.

**On-screen writing stays light** (PRD §9): short computed values only, never
sentences. The narration layer belongs to the paid bundle.

**The tour is seven short steps**, one per object. PRD §6.5 asked for three until
it was revised on 2026-08-10 to match what shipped — so this is settled, not
drift. The rule is one or two sentences per step; there is no step budget.

## Layout

```
packages/engine/src/          shared with Warp; additive only
  dual.ts      forward-mode AD — value + ∂/∂x, ∂/∂y, ∂/∂z in one pass
  elem.ts      the field language: + − × ÷ ^, trig, exp/ln, sqrt, atan2,
               hypot, r/theta sugar; ParseOpts binds `t` for curves;
               toPoly() converts back to the Poly ring when possible
  quad.ts      Gauss–Legendre, adaptive subdivision, ear-clipping
               triangulation, disk/rect/polygon integrals   [mostly SHELVED]
  field.ts     div/curl (numeric via duals, symbolic via Poly), symbolic
               differentiation for grad, work/flux/arcLength   [work/flux SHELVED]

apps/flux/src/
  rows.ts            document model + resolution + short row readouts
  geometry.ts        parameterized curve resolution
  handles.ts         selection-plus-nudge substrate (keyboard-first)
  history.ts         undo/redo over rows
  narrate.ts         canvas screen-reader label (and nothing else)
  colors.ts          graph palette — single source of truth for canvas + dots
  format.ts          number → display text
  persist.ts         versioned URL hash (#f1=…), localStorage, starter scene
  components/
    FieldCanvas.tsx  arrows, curves, points, handles, pan/zoom, keyboard
    RowList.tsx      the expression list
    SidebarHeader.tsx  brand, undo/redo, recentre, share, + menu
    Tour.tsx         ghost/spotlight tutorial
    Icons.tsx        header glyphs
```

## Invariants worth not breaking

These each cost real debugging to get right.

1. **Every cell evaluates in the full document environment.** Warp's matrix cells
   use an empty env, so a slider name silently reads 0 — that cost a lesson
   redesign. Flux resolves against the real scope and reports unknown names.
2. **The canvas draw effect depends on the memoized values, not a summary
   string.** An earlier version keyed on a string containing field *names* but not
   their *expressions*: every readout updated correctly while the canvas kept
   drawing a stale field. Found only by scanning pixels.
3. **Arrow length saturates through `tanh`, and the reference magnitude is the
   window *median*.** A mean lets one near-singular sample wash the whole picture
   pale on any 1/r field.
4. **The arrow lattice is aligned to world coordinates**, so the origin is always
   sampled — otherwise a singularity there gets its marker only by luck. Plus a
   local blow-up hunt for singularities between lattice points, clustered so one
   singularity reports once.
4b. **A singularity is decided by divergence under refinement, never by comparing
   a magnitude to the window.** The first version marked anything above 60× the
   window median, which conflates *large* with *undefined*: `(e^x, 2)` drew
   275–486 phantom markers and burned ~35,000 field evaluations a frame hunting
   them. A pole is the thing whose peak keeps growing as the search box halves;
   every smooth field's peak plateaus, however big it is. Measured margin: poles
   grow ≥ 1024×, `(e^(3x), 2)` peaking at 3.9e17 grows 1.00×. Two supporting
   details are load-bearing — the candidate filter is "local maximum among the
   eight lattice neighbours" with **ties allowed** (a strict test misses a pole
   equidistant from four samples, and ties cost nothing since the magnitudes are
   already in hand), and the climb must **not** bail out early on a round that
   finds no improvement, which aborted the search before the box was fine enough
   to reach a pole near a lattice point — 4 misses out of 12 with it in.
4c. **Non-finite has two causes and they draw differently.** An open circle means
   undefined; an open **square** means the field is defined but its magnitude left
   double range, which `(e^x, 2)` does past x ≈ 709. `classifyNonFinite` in the
   engine decides, and the canvas, the point row and the screen-reader label all
   read from it so they cannot contradict each other.
4d. **Persistence is debounced, and that is a crash fix.** The view lives in the
   document, so an immediate save called `history.replaceState` on every wheel
   tick; WebKit throws `SecurityError` past ~100 calls per 30 seconds, and with no
   error boundary the throw unmounted the app mid-zoom. Measured after: 300 wheel
   events produce 16 calls, not 300. The `try/catch` in `saveState` is the
   backstop that makes a throttled write survivable regardless.
5. **Keyboard nudges are relative, pointer drags absolute.** Computing an
   absolute position from a handle reads a value that may be a render stale, so
   fast presses (key repeat) clobber instead of composing.
6. **Undo coalescing keys on *which row* changed, not on elapsed time.** A
   wall-clock window measured gaps between *effect runs* — 150–1000ms for single
   keystrokes on a busy main thread — so every character became its own undo.
7. **Point coordinates are text, like every other cell.** Makes blank rows
   trivial, avoids the "can't type a minus sign" class of bug, and lets a slider
   drive a point. A point defined by an expression draws but has no drag handle,
   so a stray drag can't destroy the expression.
8. **Every pointer gesture has a keyboard twin** (PRD §8.2). Tab cycles handles,
   arrows move them, Escape deselects; the `+` menu is arrow-navigable.

## Verified behaviour

Checked in-browser, not just typechecked:

- `(−y, x)` → `div 0` / `curl 2` printed exactly; `(x², xy)` → `div 3x` / `curl y`.
- `(−y, x)/(x²+y²)` renders with no smear and an open circle at the origin;
  non-polynomial fields print nothing rather than a long pointwise line.
- A slider drives a field component live (`a = −3` → `curl −6`).
- Typing `-2.75` into a point coordinate survives character by character.
- Dot colours match what each row draws (navy / green / orange).
- No row wraps at 1440px or 1100px, or with a long expression.
- Five typed characters = one ⌘Z; three rapid row adds = three undos.
- New field/point/curve rows are blank and raise no error.
- Tour step 2 quotes the *actual* field; spotlight lands on the real element.
- A curve reports `length`, and the whole scene round-trips the `#f1=` hash — a
  hash from another format version shows the starter scene and says so.
- `(e^x, 2)` over x ∈ [0.5, 15.5] draws **no** markers at all (it drew ~300).
- The same field panned to x ≈ 712 draws open **squares**, with the boundary
  landing exactly where `Math.exp` overflows, and arrows intact to its left.
- `1/(x − 2.31)` marks its pole line with circles between the x = 2 and x = 2.5
  lattice columns, arrows reversing across it.
- `(−y, x)/(x²+y²)` still marks the origin with one circle and no smear.
- 300 synthetic wheel events: 16 `replaceState` calls, no throw, still mounted.
- 125 engine tests pass; Warp and landing build unaffected.

## Open items

- **`packages/ui` doesn't exist yet.** The PRD commits to it. Flux's row list and
  tour are close enough to Warp's again after the v0.2 cut that extraction is
  easier than it was; Warp must keep its own copy until after Aug 31.
- Whether `div`/`curl` should show a pointwise value for non-polynomial fields
  (PRD §14.2) — currently deliberately silent.
- A real polar-*components* mode (r̂/θ̂ basis). `r`/`theta` today are scalar
  shorthands inside Cartesian components, which students conflate.
