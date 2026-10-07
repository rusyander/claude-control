# Phase 4 — classification contract

Every diff lands in exactly one bucket. This table is the skill's promise: AUTO happens without
asking, ESCALATE never happens without asking, LEGIT never happens.

| Bucket       | What                                                                                                                                                                                                                                                    | Action                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **AUTO**     | color/fill/stroke, font family/size/weight/line-height/letter-spacing, padding/margin/gap, border-radius, border, shadow, opacity, element size, icon (glyph/size/color), state styles, transition duration+easing+delay                                | fix now                             |
| **ESCALATE** | missing or extra element, different component used, restructured layout (row↔column, moved block, different grid), size delta >30% after the scale policy, value that needs backend/data, change that conflicts with app logic or breaks another screen | write to file, do NOT fix           |
| **LEGIT**    | real data content vs mock text, font rendering + antialiasing, scrollbar, platform chrome, animation mid-frame, and — only in PROPORTIONAL mode — viewport-driven container width and fill degree                                                       | never fix, never report as a defect |

Nothing here ever blocks: an ESCALATE item is recorded and the run moves on.

## Scale policy math

`k = frontViewportWidth / figmaFrameWidth`, both from the actual run.

**STRICT** — expected = Figma value verbatim (after semantic snapping below). Tolerance ±1px,
colors exact. Fixed-width / no-adaptive target: only the agreed width is measured; other
breakpoints are out of scope and no responsive findings are raised.

**PROPORTIONAL** — decide once which shape the front is, state the verdict in one line:

- **Breakpoint shape** (fluid containers / max-width / `fr` grid; the design is one breakpoint
  of a responsive set) → `k` applies to container widths ONLY. Typography, padding, radius,
  icon size stay absolute: 16px is 16px at any viewport.
- **Canvas shape** (fixed canvas: kiosk, TV, whole mobile screen scaled) → everything scales by
  `k`, implemented ONCE at the root (rem base / scale factor), never as per-property numbers.

Tolerance ±2px or ±2%, whichever is larger. Colors, icon vectors, font weights and composition
never scale.

## Semantic snapping — from THIS Figma file, not from a global grid

Designers slip: 11px where the file everywhere else uses 12, font-size 17 where the ramp is 16.
Reproducing the slip is not parity, it is copying a typo. So, before fixing anything, build an
inventory from the CACHED spec of all audited nodes: histograms of font sizes, spacings, radii,
sizes, and hex colors, plus the project's existing DS scale as a second signal. Write it to
`.agent/figma-parity/scale-inventory.agent.md`.

A value is snapped only when ALL of these hold:

1. A **dominant** neighbour exists — same category, clearly more frequent (rule of thumb: ≥3
   occurrences and ≥3× the outlier's count) or an unmistakable ramp member (4/8/12/16/24…).
2. The delta is tiny: ≤1px for font size and radius, ≤1px for spacing <24px, ≤2px for spacing
   ≥24px, and for colors <1.5% per channel.
3. The outlier is **not** itself frequent — 11px appearing twenty times is a deliberate choice,
   not a slip.
4. The value is **not** bound to a Figma variable. A bound variable is the designer speaking
   deliberately: take it verbatim, never snap.

No detectable dominant ramp → snap nothing, use values verbatim. Every snap is logged as
`figma 11 → applied 12 (dominant, occurs 24×)` in `.agent/figma-parity/SNAPPED.agent.md` and
surfaced in the final report, so a real intentional 11px can be put back in one line.

## Fixing: the exact value wins over token purity

Order of preference, and it never stalls the run:

1. A DS token whose value **equals** the target → use the token.
2. No such token → **write the exact Figma value** (hex, px) into the project's normal styling
   layer. Do not substitute a "near enough" token, do not escalate, do not wait for the tokens
   page. Getting the pixel right is the job; naming it is the user's call afterwards.
3. Log every such case in `.agent/figma-parity/NO-TOKEN.agent.md`: the value, where it was applied
   (`file:line`), the element, and which Figma variable name (if any) the spec mentioned.
   Colors get their own section — they are the ones worth turning into variables.
4. Never an inline style to beat the theme, never `!important`, unless that is the project's
   own idiom.
5. A token used by several screens: changing it is a cross-screen change — check the other
   consumers first; if the change would hurt one of them, keep the token and apply the exact
   value locally instead, and log that reasoning.

At the end, the report asks the user to open the tokens page in Figma so they can compare the
collected palette and decide which of these become variables.

## Icons absent from the codebase — placeholder, not a blocker

The design uses an icon the project does not have (and the SVG cannot be taken from the cached
`icons/`). Do not skip the element, do not substitute a lookalike, do not stop:

1. Insert the project's placeholder icon primitive at the **designed box size, color and optical
   position**, carrying the Figma icon's own name — e.g.
   `<Icon name="placeholder" data-figma-icon="ic/heart-outline" />`. Greppable, obviously
   temporary, geometry already correct so the surrounding layout scores as parity.
2. Log it in `.agent/figma-parity/ICONS-MISSING.agent.md`: Figma icon name, node, screens, where the
   placeholder sits (`file:line`).
3. The affected checks stay marked as misses in that element's icon-glyph property — a
   placeholder is not parity. Geometry around it counts, the glyph does not.
4. Final report: the list plus the one request — open the icons page in Figma so the assets can
   be exported.

## When the spec is thin

A frame without auto-layout still yields geometry: `get_metadata` returns absolute bounds per
node, so paddings and gaps are computable as differences between sibling bounds, and sizes read
directly. Use that before declaring anything unmeasurable. Only a property that neither
`get_design_context` nor the bounds can give (e.g. a hover color the designer never drew) is
genuinely unverifiable — and then it is `unverified`, not a defect and not a silent pass.
