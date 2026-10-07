# Phase 2 — measurement (numbers only)

A finding without two numbers (Figma value, front value) is not a finding. `capture.md` must be
set up first — a measurement taken on an unsettled page is a flake, not a finding.

## Web target

Per screen, 3-5 passes, each with a DIFFERENT lens — diversification finds more than repetition.
Lens agents in parallel only when picked at intake; otherwise I run the lenses in sequence, same
outputs:

1. colors / fills / borders / shadows / opacity
2. spacing: padding, margin, gap, and radii
3. typography: family, size, weight, line-height, letter-spacing, text color, truncation
4. icons and assets: glyph identity (SVG path), size, color, optical alignment
5. states: hover/focus/active/disabled/error/empty/loading — plus the neighbouring breakpoints
   ONLY if the target is adaptive and the design covers them (Q3); otherwise this lens spends
   its budget on states alone

Each lens, from the CACHED Figma reference (never calling Figma itself):

- opens the live URL with the project e2e kit, screenshots it;
- pulls a node map via `page.evaluate` — `getComputedStyle` + `getBoundingClientRect` for the
  elements its lens covers; rgb→hex normalised; px as numbers;
- compares against the expected value AFTER the scale policy from `parity-rules.md`;
- locates the owning code (`file:line`) so the fix phase doesn't re-search;
- returns rows: `element · property · figma · front · delta · bucket · file:line`, plus the
  full table written to `.agent/figma-parity/raw/<screen>-<lens>.agent.md`; chat return ≤10 lines.

Merge into ONE deduped list per screen. Same item from several lenses → one row with
confidence (how many of N confirmed). Reported by a single lens → keep, but verify the number
before acting on it.

## Non-web target (React Native, native, Flutter)

No computed styles. Substitute: read the resolved style objects from source (theme + style
sheet + inline props) as the "front" side, and verify visually on a device/simulator
screenshot measured at known scale factor (`k` includes the device pixel ratio). Buckets and
tolerances are unchanged. State explicitly in the report that the front side came from source,
not from a live computed style — it is a weaker verification.

## What never counts as evidence

Whole-screenshot pixel diff as a verdict (always red across viewports), "looks close",
an agent's prose summary without numbers, a Figma value read off the screenshot instead of
`get_design_context`.
