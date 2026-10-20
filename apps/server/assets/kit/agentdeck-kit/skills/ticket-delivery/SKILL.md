---
name: ticket-delivery
description: "Use when a ticket or task is handed over to deliver end to end — claim, fix, one deep review, live run, one gate, MR: 'take this ticket', 'do PROJ-123'."
---

# Ticket → an MR that is ready to merge

One conveyor, identical every run, end to end, asking only at the stops at the bottom. **Nothing
about the project is assumed**: tracker, forge, gates, branch convention and stand are DISCOVERED at
the stage that needs them; an absent one degrades that stage and is named in the report. This skill
outranks a project's own delivery skill: that one only supplies project facts — gate commands,
tracker statuses, the stand — and its gates join the pre-push run.

**Fast by construction**: every check runs ONCE, at the depth the §3 risk tier buys, and the MR is
the finish line. ONE `deep-review` per task, adaptive (T0 trivial: none) · one full gate per task, on the
final tree, right before the push · the pipeline is not read · a conflict-free MR is never rebased ·
after the MR only a reviewer thread or a target conflict reopens the task.

**Run order** — sections keep the ledger ids, they run in this order:
§1 → §2 → §3 → §4 → §5 → §9 → §10 with §7 → §6 → §8 → §11 → §12 → §13 → §14.

**Read the stage's page before running it** — below is the rule and gate, the page is how:
[stages.md](references/stages.md) §1–§5, §13, red flags · [gates.md](references/gates.md) §6, §11 ·
[review.md](references/review.md) §9 · [live-run.md](references/live-run.md) §10 ·
[artifacts.md](references/artifacts.md) — every text the run emits, several tickets in one handover ·
[discovery.md](references/discovery.md) — detecting every piece, what degrades without it ·
[profiles.md](references/profiles.md) §3 — the profile pick, the MR follow-up mode.

## Working discipline — the whole run

- Read narrow: Grep the symbol, then Read with `offset`/`limit`; an unchanged file is never re-read.
- Between edits only NARROW checks: the touched files' tests (`vitest related <files> --run`,
  `go test ./<pkg>/...`, `pytest <file>`) and the touched package's type-check/lint. The full gate
  is §6, once (gates.md §When the full gate runs).
- A long command (build, suite, stand boot) → `run_in_background` or an explicit `timeout`; never
  `sleep`-polled; no exit after 30 min → stopped and treated as red, the cause named.
- Source is edited through the editor tool, never `sed -i` or a scripted rewrite.
- Local commits are free at any point; nothing is pushed before §6 is green (git-guard enforces).

## Standing authorisations — for the taken ticket only

git branch/checkout/commit/push/fetch · on a target CONFLICT only: `rebase` onto the trunk, then
`push --force-with-lease` to this ticket's own branch · creating and updating the MR · tracker
assign, comment, link and the §1 move to in-progress (every LATER status change asks — §12) · the
frontend code the fix needs · **backend** (Go/Python/SQL/Helm/CI) only after ONE yes, asked in §1 —
the global read-only default holds until then; a no → the frontend part ships, the backend fix is
named at `file:line` in the report · review subagents in §9 as `deep-review` plans them, nowhere else. A
project's own grants (a standing backend yes, say) still apply under this skill.

Never authorised: merging · deleting a branch, tag, issue or page · any other force-push (bare
`--force`, `+refspec`, a branch not this ticket's) · DDL or any data write. DB stays
`SELECT`/`EXPLAIN`/schema. **No ticket means no standing grant** — ad-hoc work keeps the normal
per-op git gate.

## The ledger — written as you go, never at the end

`.agent/tickets/<KEY>.agent.md`, created in §1, appended at EVERY gate; the MR text and the QA
comment are copied FROM it. After a compaction or `/clear` read it first and resume at the first
stage in the run order with no line.

```bash
node <kit>/tools/ticket-ledger.mjs init  PROJ-777 "<title>"
node <kit>/tools/ticket-ledger.mjs add   PROJ-777 03-plan ok "5 acceptance items"
node <kit>/tools/ticket-ledger.mjs check PROJ-777      # what is still missing
```

Statuses, the no-key slug and the one-sitting flag: stages.md §Ledger.

## 1. Read the task, classify by CODE, claim it

Every comment read, the defect located in code — the classification comes from the code. In a panel
group the tracker text is already in `.agent/run/tickets.md`: read it, go to the tracker only for
what it lacks. Preflight read-only first; **the claim (assignee) is the FIRST write**; the design
question is asked here or never.

**Gate:** in-progress with me as assignee; the ledger holds the classification with its `file:line`.

## 2. Pre-flight, then branch

`git fetch`, branch off the FRESH trunk head, named per convention; a dirty tree is never stashed. A
panel group already sits on its own branch — keep it.

**Gate:** `git branch --show-current` is the ticket's branch, tree clean, branch point = trunk head.

## 3. Decompose before the first edit

The expected result as checkable statements, each a future §10 row; `risk-tier.mjs` → tier and
radius, run ONCE here. The tier sizes the §10 walk and `mustfail`; for §9 it is a hint to `deep-review`.
The profile is picked here too, once — design / frontend / backend / fullstack / none — and its page
is read before §4 (profiles.md); an MR with reviewer threads runs the follow-up mode instead.

**Gate:** plan in the ledger, verification method per item, ≥1 negative statement, the tier, the profile.

## 4. BEFORE shots — before the first edit

Visible change only; one `BEFORE|AFTER` script for both. Nothing is uploaded before §8.

**Gate:** BEFORE files on disk and the logged text matches the reported defect.

## 5. Fix

The package's idiom — the style profile loaded before the first edit
(`agentdeck-kit:style-conformance-review` Phase 0); i18n in every locale; docs in the change or a
`Docs-Impact: none` line; the backend checklist item by item; narrow checks only. Last act: the
six-classes row, then `agentdeck-kit:style-conformance-review` over the whole diff (review.md §Style
self-review).

**Gate:** narrow checks green, the `classes` row written, the style pass reported.

## 9. Review — ONE `deep-review`, adaptive

T0 trivial (copy, spacing, typo — nothing behaviour-bearing) → no review: the author answers the
surface list as one ledger row. Anything else → invoke `deep-review` ONCE, own-code mode, over the
branch diff, the §3 tier and radius handed over as a HINT: it plans its own lanes, agent count and
rounds, and its fix loop is this stage. Never a second review pass after it. A panel review stage
follows → no spawn here, `09-review skip "panel review stage"`. Findings are claims — **each verified
at its `file:line` before any fix**; fixes take narrow checks only. `mustfail` ONCE, batched over the
bug-fixed files. Then commit locally (review.md).

**Gate:** every finding in the ledger `confirmed → fixed` or `rejected → why`, plus **raised N ·
confirmed M · rejected K**; each fix named with its test and the `mustfail` verdict or recorded as
visual-only; narrow checks green.

## 10. Live run — with the AFTER shots of §7 in the same walk

T0 → `skip` naming why nothing behaviour-bearing changed. T1 → one positive and one negative row,
the negative failing correctly. T2 → plus two variations. Verdict = the printed acceptance table on
the head sha, shown red against the pre-fix state once (live-run.md). A bug found here → fixed,
narrow checks, only the touched rows retested.

**Gate:** the table printed with zero failures, ≥1 negative row, the variation and walked rows the
tier owes.

## 7. AFTER shots — same walk as §10

Visible change only; HMR is live — shoot during the walk, the same script as §4. Folder README:
artifacts.md §Shots.

**Gate:** the logged DOM text now matches the expected result.

## 6. The gate — ONE run on the final tree, right before the push

Exactly what CI runs, never invented, as one command; `--affected` keeps it inside the touched zones
when the change allows (CI runs everything on the push):

```bash
node <kit>/tools/gate-run.mjs --affected --ticket PROJ-777 "lint=npm run lint" "test=npm run test:ci"
```

The positionals are the FULL gate. `affected.mjs` (zone map derived from manifests, rebuilt by itself)
picks SCOPED — the touched zones plus their dependents, each with its own commands — or FULL with the
reason printed (root config, lockfile, CI file, code outside every zone, no CI running tests, ≥60% of
zones, a full gate cheap enough). The verdict is not argued with; `--full` / `.agent/affected.json`
`alwaysFull` when the user wants everything. Gates CI cannot see (brand, a11y on a stand) go in as
`"always:label=cmd"`. The runner writes `06-gates` from REAL exit codes; an autofix is not the verdict. It runs once, after
§9 and §10 are closed and committed; a green run on an unchanged tree is reused, never repeated (the
runner memoises per tree, a commit does not change it; `--fresh` only on an explicit ask). Re-run
only after an edit. Not runnable locally → CI's image, never `skip`. **Red blocks** the push and the
undraft; an escape line counts once the rerun WITH it in the commit is green.

**Gate:** verdict green and the matching `06-gates — ok` row written by the runner.

## 8. Push, MR — in one sitting

Commit per artifacts.md; push; MR into the trunk as a draft with the FULL description built from the
ledger (squash, remove source branch), read back (artifacts.md §MR audit), then out of draft — one
sitting, no stage between. The tracker gets the **MR URL only**.

**Gate:** the commit is in `git log -1`, the push reports the remote branch, the MR exists, its
description passed the read-back, the ticket shows exactly one link.

## 11. Pipeline — not read; the target, only on a conflict

`11-pipeline skip "not read"` — no read, poll, sleep or watcher; the user reads CI (gates.md
§Pipeline). The MR conflicts with the target → `fetch` + `rebase`, the touched packages' checks,
`push --force-with-lease`. No conflict → nothing, however far the trunk moved.

**Gate:** the `11-pipeline` row; a conflict, if any, cleared and pushed.

## 12. Finish: ticket to review, QA instructions

The review move and the QA comment from the ledger, read back — the plan, never a question, gated on
§9 + §10 only. Human threads: re-read only when the MR pre-existed or a thread arrived during the run
— one discussions call (review.md §Human threads). **Everything past review still asks**: pulling QA
in is the user's call.

**Gate:** the MR out of draft; the tracker shows review and the read-back QA comment; threads read,
if owed, at 0 unresolved.

## 13. Cleanup — same turn, nothing left running

Kill what THIS ticket started (the dev server by its `10-live` PID/port), delete what it created on a
shared stand; reusable things and a stand the user already ran stay (stages.md §13).

**Gate:** a ledger line naming what died (port now closed), what was deleted by id, and what was kept.

## 14. Report — then the task is DONE

In the user's language, short, per artifacts.md §Final report. Every absent piece and everything NOT
verified is named with its reason: absent infrastructure downgrades the CLAIM, never the standard.
Self-check first: stages.md §Red flags. After it nothing runs: no CI read, no trunk tracking — only a
reviewer thread (fix + answer) or a target conflict (§11) reopens the task.

## Stop and ask — do not improvise

- The ticket is assigned to someone else, or already in progress elsewhere.
- The working tree is dirty at §2.
- The fix needs a DB migration, DDL or any data write.
- The expected result is still ambiguous after every comment.
- The same gate is red a third time on the same cause.
- A second infrastructure death on the same CI job.
- Anything that would need a merge, a deletion, or a force-push beyond the §11 lease.
- Before touching a dependency, CI image or build config no confirmed finding needs — recommend
  leaving it out (review.md §Rejected claims).
