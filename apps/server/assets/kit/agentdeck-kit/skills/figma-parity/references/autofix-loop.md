# Phases 4-5 — autonomous fix loop and the decision file

## Per-screen loop (AUTO mode)

Screens are processed sequentially — measurement fans out, fixing does not (parallel edits to
shared tokens collide).

```
for screen in queue:
  1. checklist built (scoring.md) + BEFORE shots per capture.md, before any edit
  2. apply all AUTO items (parity-rules.md: token if one matches, else the exact Figma value)
  3. LIVE GATE — fresh page load, statics + touched dynamics re-measured, score computed
  4. score >= floor and no open structural items? → next screen
  5. improving by >=0.5pp? → iterate (hard cap 5). Not improving → partial, shortfall itemized
  6. AFTER shots + state/motion strips, append screen + score to report.json, update PROGRESS.md
```

The gate is a **fresh** run, never a re-measure of the already-mutated page — that is what
catches a fix which only worked in the live DOM or lost to specificity on a cold load.

An item is never fixed twice: the second failure escalates it with what was tried. A fix that
breaks a neighbouring element is reverted, not patched on top. A shared token touched by several
screens → re-score its other consumers before moving on; a regression there outranks the parity
win that caused it.

Fill `report.json` as you go, not at the end — a compaction or a crash then costs one screen,
not the run. Same reason `.agent/PROGRESS.md` carries the queue with per-screen status.

**Reload assumption.** Default: the stand hot-reloads, so step 3 runs immediately after step 2 —
no waiting, no asking. Only when the user said they will rebuild does the loop stop after the
last screen, report, and re-verify on their word. Either way a screen is verified by a
re-measure, never by reasoning.

**Never block.** Mid-run the skill does not ask anything. Anything that would be a question is
a file entry (`DECISIONS.md`, `ASK-FIGMA.md`, `NO-TOKEN.md`, `SNAPPED.md`) and the queue keeps
moving. A screen that cannot be reached at all is `blocked` with a reason — the run continues.

Behaviour, data flow and logic stay unchanged throughout — this skill changes appearance.

## Decision file

Per screen `.agent/figma-parity/<screen>.agent.md`, in the user's language (the user reads it):

```
# <screen> — what is left for decision
Figma <node-id> · <url> · mode STRICT|PROPORTIONAL (k=1.5) · <date>

| # | Element (file:line) | In Figma | On the front | Type | Recommendation | Why |
```

`Type` ∈ missing / extra / different-component / layout / size>30% / needs-backend /
conflicts-with-logic / no-token. `Recommendation` ∈ FIX / NO FIX / NEEDS BACKEND — with a
one-line reason, so the answer is a yes/no per row and nothing has to be re-investigated.

Roll-up `.agent/figma-parity/DECISIONS.agent.md` — one line per open item across all screens,
grouped by recommendation, newest run on top. Delivered rows move out on the next run.

Also record, per screen, what was auto-fixed (count + categories) and what was classified
LEGIT — so the user can challenge a classification without re-running the audit.

## Then Phase 6

The decision files are the text half; `references/report.md` builds the visual half from the
same data. Chat answer format lives there — keep it short.
