---
name: task-spec-builder
description: 'Use when a raw batch of tasks or bugs arrives; build TASKS.md with where-in-code, acceptance, verification.'
---

# Raw tasks → spec in TASKS.md

The user formulates tasks tersely (screenshot + a few phrases). Your job: expand them into a verifiable spec **before** any fixes — anchored to the project's code, with acceptance criteria and a verification plan. The spec lives in `TASKS.md` at the **project root**. It is HUMAN-facing: write it in the user's language (Russian) — they check how you understood the tasks, track statuses, copy wording into their tracker. For you it is the recheck anchor: "is everything done, and how was it verified?"

## Phase 1. Intake → file skeleton (immediately)

1. Create `TASKS.md` at project root. File already exists with an old batch → do NOT rewrite: append a new section `## Batch of DD.MM.YYYY` (in the user's language) at the bottom.
2. Record each task under the **user's number** ("task 1" = T1 — their numbering matters for cross-references) + symptom close to their words + what's on the screenshot.
3. Never commit the file (user's working artifact); the FILE itself always stays — delivered ENTRIES follow the Phase 4 lifecycle.

## Phase 2. Analyze → expand into spec (before edits!)

For each task find where it lives in code (files/components/routes/endpoints — with paths) and form a root-cause hypothesis. Big batch → recon in sequence, findings per task written as they land; parallel recon subagents only on the user's go-ahead for THIS batch. Ambiguities → ask the user NOW (interactive choices on real forks), not mid-fix; several open forks at once → skill `agentdeck-kit:requirements-grilling` for the round-based version.

Two lines every entry carries, because their absence is what scope creep grows in:

- **Explicitly NOT in scope** — the neighbouring thing a reader would assume is included. An unstated boundary is not a boundary.
- **Test coverage of that area today** — none, and the change is risky → say so and ask whether tests come first, rather than discovering the missing net mid-change.

Big batch → one batch-level section "Not specified yet" at its bottom: suspected work too fuzzy to spec yet (fog, not tickets). Park it there visibly instead of losing it; graduate an item to a T<N> entry the moment it can be stated sharply. Ruled-out work goes to the entry's NOT-in-scope line, never to fog.

**Read `references/task-template.md` before writing entries** — it holds the literal entry template (structure kept, labels in the user's language) and the acceptance-criteria quality bar (verifiable, not vague; ~10-15 lines per entry).

Task spans layers (schema + API + UI) or won't fit one context window → read `references/slicing.md` BEFORE splitting into T<N>.x — vertical tracer-bullet slices, blocking edges, expand→migrate→contract for wide refactors.

### Review remarks — claims, verified before accepting

A batch of review remarks (MR threads, a reviewer's list) is claims, not tasks. Done when every remark has exactly one verdict:

1. Check each against the code at the MR head — the line it names, its call sites, the test covering it.
2. Verdict: **FIX** — holds; becomes a T<N>, the remark quoted as the symptom. **DISAGREE** — does not hold; the entry carries the counter-fact (`file:line`, a run, a spec line), status ❌ with that reason. **CLARIFY** — the ask itself is unclear.
3. Any CLARIFY blocks the whole batch: remarks are often related, and a partial read fixes the wrong half. Ask every CLARIFY at once, then start.
   Replies to the reviewer → situational rule `published-text` (REVIEW REPLIES).

## Phase 3. Work the spec

- Update statuses as you go (the file is live progress for the user).
- Root cause turned out different → fix "Cause" in the spec, don't leave a false hypothesis.
- Subtask surfaced → add as T<N>.1 inside the parent, don't lose it.
- UI tasks: the mandatory before/after screenshot workflow applies (global rule) — put links to the screenshot folder into "Verification"/"Solution".
- Write "Symptom/Expected/Solution" so the task can be copied into a tracker as-is — self-contained, no references to chat context.

## Phase 4. Wrap-up

- After verification fill "Solution" and tick criterion checkboxes for every task; be honest about partial/blocked — what is not done and why, what is needed from the user.
- After the whole batch of fixes → run skill `agentdeck-kit:style-conformance-review`; mention its result in the batch summary.
- End with a summary table (no. → name → status).
- Delivered entries follow the repo's TASKS.md lifecycle — the project CLAUDE.md wins (some repos delete entries outright); global default: move them to `.agent/archive/TASKS-done-<date>.md` in the same pass. The FILE and other people's batches always stay.

## Red flags — run against the finished TASKS.md

- Started fixing before the task was expanded into a spec with acceptance criteria.
- "Expected" restates the symptom instead of verifiable criteria.
- Statuses in the file lag reality (the user watches the file, not the chat).
- Deleted/overwrote TASKS.md or someone else's batch in it.
- Spec bloated into a wall of text: a task is ~10-15 lines; diagnostic detail lives in chat, not the file.
