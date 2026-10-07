# Phase 3 — motion, states, live data

The design is not only geometry. This pass runs the app for real; nothing here is judged from a
still frame. Preconditions from `capture.md` apply, minus the motion freeze.

## 1. Motion

Reference: `motion.md` from the cache (`get_motion_context` — smart-animate/prototype timings,
only where the designer specified them). Designer specified nothing → the project's motion
convention is the reference (e.g. `shared/lib/motion/`), not an invented duration.

Compare, cheapest first:

1. **Declared timing** — `getComputedStyle(el)` → `transitionProperty/Duration/TimingFunction/
Delay`, `animationName/Duration/TimingFunction/IterationCount`. Deterministic, no frames
   needed. Duration and easing are AUTO-fixable (they are token-level in most design systems).
2. **Real behaviour** — only where timing is declared or the design defines a transition:
   trigger it, sample 3-4 frames (`motion-<name>-1..4.png`), confirm it actually animates the
   property the design animates, in that direction, once, and settles. Catches: transition
   declared but overridden, animation restarting, layout jump before the animation, a fade
   that is really a display swap.
3. **Regressions of taste** — no jank checks by eye. If the project has a motion QA script
   (`tools/qa/check-motion.mjs` style), run it and quote its numbers.

Must also hold: `prefers-reduced-motion: reduce` disables/shortens motion (a11y — if the front
ignores it, that is a finding regardless of the design) · no infinite animation on a static
screen · nothing animates on first paint that the design shows as settled.

## 2. States — driven, not assumed

For every interactive element the design has variants for: `hover()` · `focus()` and real
keyboard `Tab` (focus ring is designed, and it is the state most often missing) · `:active`
(mouse down held) · disabled · loading/pending · error · empty · selected/checked ·
open/expanded. Measure computed styles in each state and compare to the Figma variant.

Capture one state strip per component for the report. Edge cases that bite: hover on touch
targets (no hover on a mobile-width viewport — do not report it missing) · focus-visible vs focus
(design usually means focus-visible) · a state reachable only after a backend action (queue it
with the data pass) · hover styles that only exist on a parent (`:hover` on the row, not the
cell) · transition making the state shot mid-flight — settle first.

## 3. Live backend data

Text content differing from the mock is **LEGIT**. What the design guarantees and data can
break is not. Per screen, exercise:

| Case                                            | What must hold                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| long text / longest real value                  | wrap or ellipsis exactly as designed, no overflow, no layout shift |
| empty collection                                | the designed empty state appears, not a blank region               |
| single item / max items                         | paddings and dividers as designed; list does not collapse          |
| loading                                         | the designed skeleton/spinner, in the designed geometry            |
| error / 5xx                                     | the designed error state; nothing half-rendered                    |
| extreme numbers, long names, RTL-ish long words | formatting (thousands, currency, dates) as designed                |
| missing optional fields, null avatar/image      | designed placeholder, not a broken icon                            |

Prefer real backend with seeded fixtures; unavailable → route-level stubs
(`page.route`) and say in the report that the case was stubbed, not live.

Backend is read-only (global rule). A data-shaped defect that needs a backend change is
ESCALATE with kind `needs-backend`, never a frontend workaround invented to make the shot
match.

## Classification here

Duration/easing/state style values → **AUTO**. Missing state entirely, wrong element animated,
a state that needs new backend data, a designed empty/error state the front does not have →
**ESCALATE**. Content text, real data values, arrival order of async data → **LEGIT**.
