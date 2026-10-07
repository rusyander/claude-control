---
name: ticket-delivery
description: "Use when a ticket or task is handed over to deliver end to end — claim, branch, fix, gates, MR, two-agent review, live run: 'take this ticket', 'deliver PROJ-123'."
---

# Ticket → an MR that is ready to merge

One conveyor, identical every run, end to end, asking only at the stops at the bottom. **Nothing
about the project is assumed**: tracker, forge, gates, branch convention and stand are DISCOVERED at
the stage that needs them; an absent one degrades that stage and is named in the report. A project's
own delivery skill outranks this one.

**Read the stage's page before running it** — below is the rule and gate, the page is how:
[stages.md](references/stages.md) §1–§5, §13, red flags · [gates.md](references/gates.md) §6, §11 ·
[review.md](references/review.md) §9 · [live-run.md](references/live-run.md) §10 ·
[artifacts.md](references/artifacts.md) — every text the run emits, several tickets in one handover ·
[discovery.md](references/discovery.md) — detecting every piece, what degrades without it.

## Standing authorisations — for the taken ticket only

git branch/checkout/commit/push/fetch and the `rebase` onto the trunk that clears a conflict ·
creating and updating the MR · tracker assign, comment, link and the §1 move to in-progress (every
LATER status change asks — §12) · the frontend code the fix needs · **backend** (Go/Python/SQL/Helm/
CI) only after ONE yes, asked in §1 — the global read-only default holds until then; a no → the
frontend part ships, the backend fix is named at `file:line` in the report · exactly **two** review
subagents in §9, nowhere else. A project's own ticket skill and its grants take precedence.

Never authorised: merging · deleting a branch, tag, issue or page · force-push · DDL or any data
write. DB stays `SELECT`/`EXPLAIN`/schema. **No ticket means no standing grant** — ad-hoc work keeps
the normal per-op git gate.

## The ledger — written as you go, never at the end

`.agent/tickets/<KEY>.agent.md`, created in §1, appended at EVERY gate; the MR text and the QA
comment are copied FROM it. After a compaction or `/clear` read it first and resume at the first
stage with no line.

```bash
node <kit>/tools/ticket-ledger.mjs init  PROJ-777 "<title>"
node <kit>/tools/ticket-ledger.mjs add   PROJ-777 03-plan ok "5 acceptance items"
node <kit>/tools/ticket-ledger.mjs check PROJ-777      # what is still missing
```

Statuses, the no-key slug and the one-sitting flag: stages.md §Ledger.

## 1. Read the task, classify by CODE, claim it

Every comment read, the defect located in code — the classification comes from the code. Preflight
read-only first; **the claim (assignee) is the FIRST write**; the design question is asked here or never.

**Gate:** in-progress with me as assignee; the ledger holds the classification with its `file:line`.

## 2. Pre-flight, then branch

`git fetch`, branch off the FRESH trunk head, named per convention; a dirty tree is never stashed.

**Gate:** `git branch --show-current` is the new branch, tree clean, branch point = trunk head.

## 3. Decompose before the first edit

The expected result as checkable statements, each a future §10 row; `risk-tier.mjs` → tier, radius.

**Gate:** plan in the ledger, verification method per item, ≥1 negative statement.

## 4. BEFORE shots — before the first edit

Visible change only; one `BEFORE|AFTER` script for both.

**Gate:** BEFORE files on disk and the logged text matches the reported defect.

## 5. Fix

The package's idiom — the style profile loaded before the first edit (`agentdeck-kit:style-conformance-review`
Phase 0), so the §9 style pass confirms instead of rewriting; i18n in every locale; docs in the change or a `Docs-Impact: none` line;
the backend checklist item by item.

## 6. The gates — discovered, then run, all green

Exactly what CI runs, never invented, as one command:

```bash
node <kit>/tools/gate-run.mjs --ticket PROJ-777 "lint=npm run lint" "test=npm run test:ci"
```

The runner writes `06-gates` from REAL exit codes; an autofix is not the verdict. Runs again before
EVERY later commit and MR update. Not runnable locally → CI's image, never `skip`. **Red blocks**
every commit, push and undraft; an escape line counts once the rerun WITH it in the commit is green.

**Gate:** verdict green and the matching `06-gates — ok` row written by the runner.

## 7. AFTER shots, immediately

HMR is live — shoot at once. Folder README: artifacts.md §Shots.

**Gate:** the logged DOM text now matches the expected result.

## 8. Commit, push, DRAFT merge request

Commit per artifacts.md; MR into the trunk as a **draft**, squash, remove source branch; the tracker
stays in-progress and gets the **MR URL only**. §9 starts at once — the one
place to offer a clean-session handoff (artifacts.md §Handoff).

**Gate:** the commit is in `git log -1`, the push reports the remote branch, the MR exists and is a
draft, the ticket shows exactly one link.

## 9. Deep review — two agents, split by entry point

The only spawn: **A** from the diff (correctness), **B** from the frame (canon and surface). Findings
are claims — **each verified at its `file:line` before any fix**. Then `agentdeck-kit:style-conformance-review` over
the whole diff, every run (review.md §Style self-review).

**Gate:** every finding in the ledger `confirmed → fixed` or `rejected → why`, plus **raised N ·
confirmed M · rejected K**; each fix named with its test and `mustfail` verdict or recorded as
visual-only; the style pass reported; §6 green again.

## 10. Live run — the real stand, one positive and one negative

The stand runs and the flow is walked, the negative failing correctly; T2 adds two variations.
Verdict = the printed acceptance table, run on the head sha.

**Gate:** the table printed with zero failures, ≥1 negative row, and the variation and walked rows
the tier owes.

## 11. Pipeline — not watched

No poll, sleep or watcher — the user reads CI themselves (gates.md §Pipeline). At most ONE snapshot
read at §12, none when told not to track the pipeline. MR conflict → `fetch` + `rebase`, §6, push.

**Gate:** `11-pipeline ok` only on `success` at the head sha; any other state → `skip` naming the
state, pipeline id and time read — `running` is never `ok`.

## 12. Finish: MR out of draft, ticket to review, QA instructions

Order: MR threads re-read (review.md §Human threads) → Verification from the ledger, description read
back (artifacts.md §MR audit) → undraft + review move: the plan, never a question, gated on §9 + §10
only, never the pipeline. Not clean → draft and in-progress stay. **Everything past review still
asks**: pulling QA in is the user's call.

**Gate:** §9 and §10 closed clean; 0 unresolved threads at undraft; the MR is undrafted with the
audited description; the tracker shows review and the read-back QA comment.

## 13. Cleanup — same turn, nothing left running

Kill what THIS ticket started (the dev server by its `10-live` PID/port), delete what it created on a
shared stand; reusable things and a stand the user already ran stay (stages.md §13).

**Gate:** a ledger line naming what died (port now closed), what was deleted by id, and what was kept.

## 14. Report

Russian, short, per artifacts.md §Final report. Every absent piece and everything NOT verified is
named with its reason: absent infrastructure downgrades the CLAIM, never the standard. Self-check
first: stages.md §Red flags.

## Stop and ask — do not improvise

- The ticket is assigned to someone else, or already in progress elsewhere.
- The working tree is dirty at §2.
- The fix needs a DB migration, DDL or any data write.
- The expected result is still ambiguous after every comment.
- The same gate is red a third time on the same cause.
- A second infrastructure death on the same CI job.
- Anything that would need a merge, a force-push, or a deletion.
- Before touching a dependency, CI image or build config no confirmed finding needs — recommend
  leaving it out (review.md §Rejected claims).
