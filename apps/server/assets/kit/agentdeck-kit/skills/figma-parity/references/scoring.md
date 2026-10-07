# Parity score, the per-screen live gate, and when to stop iterating

## The metric — property parity, never pixel diff

A whole-screenshot pixel percentage is meaningless here: text antialiasing and font hinting
alone shift pixels, so a literally identical implementation scores far below 100%. "100%
pixel perfect" therefore means: **every checked property matches inside the mode's tolerance**.

Build the checklist BEFORE fixing, from the cached Figma tree, and publish it — a percentage
without a denominator is theatre:

```
.agent/figma-parity/checks/<screen>.json
  [{ "node": "Button/primary", "selector": "…", "prop": "background-color",
     "figma": "#2563EB", "front": "#2563EA", "tol": "exact", "ok": false }]
```

Elements = every visible node in the Figma frame that maps to a front element; properties =
those applicable to it (see the AUTO row of `parity-rules.md`). Same list is reused on every
iteration and on the final gate, so the numbers are comparable across passes.

Two numbers per screen, both published, never merged into one:

- **properties** — `matched / total (pct)`. When the user asked for 100% / pixel-perfect, the
  floor is **98%**; below that the screen is not done.
- **structural** — count of open ESCALATE items. These are _not_ averaged into the percentage
  (that would let a big missing block hide behind 400 matching properties).

`ok` requires **both**: property parity ≥98% _and_ zero open structural items. Property parity
at 99% with one missing block is `decisions`, not `ok`. Say the numbers, not an adjective.

98% is a floor, not a target: if the remaining misses are auto-fixable, fix them.

## Per-screen live gate

A screen is not left until it has passed a **fresh** live run — not a re-measure of the page
that is already open:

1. New page, full navigation, `capture.md` setup from scratch (this catches fixes that only
   worked in the mutated DOM, and CSS that lost to specificity on a cold load).
2. Statics re-measured against the full checklist → the property number.
3. The dynamics that were touched re-run (`dynamics.md`) — transition timings, the states whose
   styles changed, the data cases the fix could affect.
4. Score written to `report.json`; AFTER shots and strips captured; `.agent/PROGRESS.md` updated.
5. Miss remaining → locate it (which check, which file:line, why the previous fix did not take)
   and continue the loop. Never move on with a silent shortfall.

## Iteration policy — improvement-driven, not a fixed count

A hard "3 passes" cap can leave a screen at 95%. So:

- Iterate while a pass improves the score by ≥0.5pp.
- Hard cap 5 passes — a runaway guard, not a target.
- A pass that improves nothing stops the loop immediately: the cause is not effort, it is that
  the remaining checks are blocked (missing asset, structural, unresolvable value).
- Then the screen is `partial`, and every failed check is itemized with its reason. A shortfall
  that is never named is the one failure mode this whole skill exists to prevent.

## STRICT mode — a second, independent denominator

`AUTO+STRICT` adds one more number that is never folded into the property percentage:
**compared N/N** — final artifacts compared as images against their Figma counterpart
(`strict-sweep.md`). A screen is not `ok` in STRICT mode until its pairs are compared and every
confirmed sweep finding is fixed or escalated — a 99% property score over a checklist that never
listed the missing block is exactly the blind spot this covers.

Findings the sweep raises but numbers refute do not move either number: they are false positives,
logged, not scored, not fixed.

## Cross-screen regressions

A shared token or shared component was touched → re-score the other screens that consume it
before moving on. A neighbour whose score dropped is a regression: revert the change, apply the
value locally instead (`parity-rules.md` §"exact value wins"), and log why.

Keep every screen's last score in `.agent/PROGRESS.md` so a regression is detectable after a
context compaction.
