---
name: figma-parity
description: 'Use when matching the front to a Figma mock — pixel-perfect parity: statics, states, motion.'
---

# Figma → front parity

Bring real screens to the design: measure by NUMBERS (Figma spec vs live computed styles),
fix token-level drift autonomously, escalate only what a human must decide, and finish with
evidence the user can spot-check instead of re-walking every screen by hand.

Detail lives in `references/` — read the named file BEFORE the phase, not after.

## Non-negotiables

- **Two interruptions, ever.** One question set at the start, one decision set at the end.
  In between the run never blocks: anything that would be a question becomes a file entry.
- **Snapshot first, live Figma never by default** (where the project has a snapshot script). A
  design task starts by pulling a FULL local snapshot of the area it touches; the whole run then reads that copy. The
  100% comparison is against the snapshot; only after it is done may the user be ASKED whether an
  extra live check is wanted — quota is never spent unasked. Refresh only on their word or when a
  task lands on an area the snapshot misses or covers stale — `references/figma-access.md`.
- **Figma is the user's open window.** When live access IS sanctioned: read-only through the real
  Dev Mode MCP. Never drive its UI, never assume a page other than the one open (screens).
- **Numbers, not impressions.** No finding without a Figma value and a front value.
- **The exact value wins over token purity.** No matching token → write the Figma value as it
  is and log it; never stall, never substitute "close enough".
- **Images never enter context.** Screenshots go to disk and are embedded by
  `tools/build-report.mjs`; the model reads paths, not bytes. Sole exception: Phase 5S comparison,
  inside comparison agents when picked at intake (`references/strict-sweep.md` §5S.4).
- **STRICT mode: the denominator is every shot taken.** 32 final artifacts → 32 pairs compared
  against Figma; unmappable ones named in a file, never dropped; a visual claim acted on only
  once numbers confirm it — `references/strict-sweep.md`.
- **Verified means a fresh live run.** Every screen passes a cold-load gate before the queue
  moves on. Stand hot-reloads by default — no waiting for a rebuild unless the user said so.
- **A percentage needs a denominator.** Parity is scored over a published checklist of property
  checks, never over a screenshot pixel diff — `references/scoring.md`. "100% / pixel perfect"
  asked for → floor is 98% of property checks AND zero open structural items.
- **Nothing is skipped for lack of an asset.** Missing icon → named placeholder at the designed
  geometry + a log line, never a hole and never a lookalike.

## Phase 0 — the only question set

ALWAYS one AskUserQuestion, in the user's language, wording in `references/intake.md`: mode
(AUTO | AUTO+STRICT | AUDIT-ONLY) · scale policy (STRICT | PROPORTIONAL) · target width and whether other
widths are in scope · the agent's own proposed screen↔frame mapping to confirm · rebuild
needed (default no). Same turn, run the **preflight** from that file — every first-of-its-kind call
(Figma MCP, Playwright, Write, node, the gate, settings allowlists) made while the user is still here.
Green → one line and start; anything prompting or failing → ask now, it cannot be asked later.

## Phase 1 — reference, once, up front

`references/figma-access.md`. **Default: the snapshot.** Project has a snapshot script
(e.g. `figma:snapshot`, output `.agent/figma-snapshot/`) → pull the sections in scope and read
`INDEX.md` / `outline.txt` / `tree.json` / PNGs from disk; no MCP call at all. No script in this
project → pull once through the MCP and cache. Only where the snapshot genuinely cannot answer (live
selection, dev-status, motion) does the orchestrator alone call the MCP (rate limit +
the user's window): `get_metadata` → `get_design_context` → `get_variable_defs` →
`get_screenshot` → `get_motion_context`, cached under `.agent/figma-parity/ref/`. Off-page
references are neither fetched nor guessed: the resolved value from the screens page is applied
verbatim and the page request is logged for the final report.

## Phase 2 — capture & measure (static pass)

`references/capture.md` first — determinism beats retries: fixed viewport + DPR, fonts and
network settled, animations frozen, volatile regions masked, seeded data. Then
`references/measure.md`: 3-5 lenses, computed styles vs cached spec — parallel agents only when
picked at intake. Non-web target (RN/native) → style source + measured device screenshot.

## Phase 3 — dynamics (live pass)

`references/dynamics.md`. Animations frozen for statics are the subject here: transition
duration/easing vs `get_motion_context`, hover/focus/active/disabled/error/empty/loading
driven for real via Playwright, and live backend data stressed (long text, empty, error,
extreme numbers) — content differs legitimately, container behaviour does not.

## Phase 4 — classify

`references/parity-rules.md` — the contract, read it before classifying. Every diff lands in
exactly one bucket: **AUTO** (token-level style drift, fixed silently) · **ESCALATE** (structural
or logic-touching, written to file) · **LEGIT** (real content and rendering, never touched). The
full enumerations live only in that file.

Same file: **semantic snapping** — a value breaking the Figma file's own scale is aligned to the
dominant neighbour from a histogram of THIS file, never a global 4/8 dogma, never against a bound
variable, always logged so an intentional value can be restored.

## Phase 5 — fix loop (AUTO mode)

`references/autofix-loop.md` + `references/scoring.md`. Per screen: checklist + BEFORE shots →
apply AUTO items (token if one matches, else the exact Figma value + a log line) → **live gate**
on a cold page load, score computed → iterate while the score improves ≥0.5pp, hard cap 5 →
below the floor with no improvement = `partial` with every failed check itemized. An item that
survives two attempts is escalated. AUDIT-ONLY stops after Phase 4.

## Phase 5S — STRICT visual sweep (mode AUTO+STRICT only)

`references/strict-sweep.md`. The numeric passes check what the checklist enumerated; this one
checks what it never listed. After the queue converges: inventory EVERY final shot (screens,
states, motion end-frames, data cases) → map each to its Figma node, all of them (unmappable →
`UNMAPPED.md`; a Figma frame with no shot → captured or escalated) → `tools/visual-sweep.mjs`
builds side-by-side / overlay / attention-map per pair → batches of ≤5 pairs report what numbers
cannot see (missing or extra element, block order, alignment, glyph, crop, copy, z-order) →
**every claim re-proved with numbers**: confirmed goes into the Phase 4 buckets, unconfirmed into
`FALSE-POSITIVES.md`, never fixed on an impression. Re-capture what changed, repeat until a round
adds nothing new (cap 3). Not done while a pair is uncompared or a confirmed finding is open.

## Phase 6 — evidence report

`references/report.md`. Manifest → `tools/build-report.mjs` → local
`.agent/figma-parity/report.html`: per screen Figma next to front (overlay slider, blink,
click-to-zoom), state and motion strips, decisions table, honest status badge, plus the
palette of values written without a token, the semantic-snapping log, and the one request to
open the tokens page. Publishing it as a claude.ai Artifact uploads product screenshots — offer
it, publish only on an explicit yes. Gate once: `type-check && lint && test`. Only here, after
the report, are the batched decision questions asked — by theme, not per row.

**Final gate.** Read `references/red-flags.md` and run every line against what the run actually did.
The run is not reportable until each line is checked; a hit is fixed or named in the report, never
quietly dropped.
