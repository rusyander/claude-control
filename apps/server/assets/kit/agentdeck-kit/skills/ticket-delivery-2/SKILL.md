---
name: ticket-delivery-2
description: "Use when a ticket or task is handed over to deliver end to end into an MR — tiers T0–T3, each check once: 'take this ticket', 'do PROJ-123'."
---

# Ticket → an MR that is ready to merge (v2)

One conveyor, identical every run, end to end, asking only at the stops at the bottom. **Nothing
about the project is assumed**: tracker, forge, gates, branch convention and stand are DISCOVERED at
the stage that needs them; an absent one degrades that stage and is named in the report.

**This skill drives the stages.** A project's own delivery skill is a source of FACTS only — gate
command or gate tool, tracker ids, branch shape, stand, artifact folders, fixed comment markers —
read once at §1 (stages.md §3 Facts) and used verbatim; its gates join §6, its grants (a standing
backend yes) still apply, its stage order does not.

**Run order** — sections keep the ledger ids, they run in this order:
§1 → §2 → §3 → §4 → §5 → §9 → §10 with §7 → §6 → §8 → §11 → §12 → §13 → §14.

**Read the stage's page before running it** — below is the rule and gate, the page is how:
[stages.md](references/stages.md) §1–§5, §13, red flags · [gates.md](references/gates.md) §6, §11 ·
[review.md](references/review.md) §9 · [live-run.md](references/live-run.md) §10 ·
[artifacts.md](references/artifacts.md) — every text the run emits, several tickets in one handover ·
[discovery.md](references/discovery.md) — detecting every piece, what degrades without it ·
[profiles.md](references/profiles.md) §3 — the profile pick, the MR follow-up mode.

## Tier — computed ONCE at §3, sizes every check of the run

`node <kit>/tools/risk-tier.mjs` prints T0/T1/T2, its markers and the radius. **Lift to T3** when
any holds: two or more distinct markers among access, money, schema/contract, irreversible · the
radius printed past the T2 cap · a migration or DDL in the diff · the panel group or the user says
strict. The tier only rises: one recompute when the diff gains a file outside the printed radius or
a new marker, never a drop.

| Check                                                  | T0                 | T1                         | T2                         | T3                                          |
| ------------------------------------------------------ | ------------------ | -------------------------- | -------------------------- | ------------------------------------------- |
| narrow (touched files' tests, package type-check/lint) | per edit batch     | per edit batch             | per edit batch             | per edit batch                              |
| style pass, end of §5                                  | once               | once                       | once                       | once                                        |
| §9 review                                              | self row           | one `deep-review`          | one `deep-review`          | one `deep-review` + cold verify of each fix |
| `mustfail`                                             | —                  | bug-fix files, once        | + marked behaviour files   | every behaviour file                        |
| §10 walk                                               | skip, why named    | 1 pos + 1 neg + entries ≤3 | + 2 variations, entries ≤6 | + 3 variations incl. role, every entry      |
| red run of the table                                   | —                  | cheapest real red          | full, pre-fix              | full, pre-fix                               |
| §6 gate                                                | `--affected`, once | `--affected`, once         | `--affected`, once         | `--full`, once                              |

**Every check runs once per tree.** Each run is a ledger row carrying the head sha it ran on; the
same check on the same tree reuses that row. After an edit only what the edit touched re-runs: the
touched files' narrow checks, the §10 rows whose screens or endpoints it touched, `mustfail` of a
newly bug-fixed file. The gate runner and `mustfail` memoise per tree; `--fresh` only on an explicit
ask. Twice-run full checks are what this skill exists to remove — a group once ran its gate 11× at
8–13 min each.

## Working discipline — the whole run

- Read narrow: Grep the symbol, then Read with `offset`/`limit`; a file over 30 KB never whole; an
  unchanged file is never re-read. A diff is read per file (`--stat` first), a re-check reads only
  the fix delta.
- Between edits only NARROW checks (the table's first row). Independent reads and edits batch into
  one message.
- A long command (build, suite, stand boot) → `run_in_background` or an explicit `timeout`; never
  `sleep`-polled; no exit after 30 min → stopped and treated as red, the cause named.
- Source is edited through the editor tool or a script FILE run by path, never `sed -i` or `node -e`.
- In a worktree every artifact stays in the copy and a resumed stage reuses it (stages.md §13).
- Local commits are free at any point; nothing is pushed before §6 is green.

## Standing authorisations — for the taken ticket only

git branch/checkout/commit/push/fetch · on a target CONFLICT only: `rebase` onto the trunk, then
`push --force-with-lease` to this ticket's own branch · creating and updating the MR · tracker
assign, comment, link and the §1 move to in-progress (every LATER status change asks — §12) · the
frontend code the fix needs · **backend** (Go/Python/SQL/Helm/CI) only after ONE yes, asked in §1,
or a project grant that already gives it — otherwise the frontend part ships and the backend fix is
named at `file:line` · review subagents in §9 as `deep-review` plans them, nowhere else.

Never authorised: merging · deleting a branch, tag, issue or page · any other force-push · DDL or any
data write (DB stays `SELECT`/`EXPLAIN`/schema). **No ticket means no standing grant.**

## The ledger — written as you go, never at the end

`.agent/tickets/<KEY>.agent.md` via `node <kit>/tools/ticket-ledger.mjs`: `init` in §1, one `add`
per stage as its last act, `check` before §14; the MR text and the QA comment are copied FROM it.
After a compaction or `/clear` read it first and resume at the first stage in the run order with no
line. Commands, statuses, slug, late rows: stages.md §Ledger.

## 1. Read the task, classify by CODE, claim it

Every comment read, the defect located in code; the classification comes from the code. Panel group
→ the tracker text is in `.agent/run/tickets.md`. Preflight read-only, project facts read, then **the
claim (assignee) is the FIRST write**. The design and backend questions are asked here or never.
**Gate:** in-progress with me as assignee; `01-claim` holds the classification with its `file:line`
and the project facts found.

## 2. Pre-flight, then branch

`git fetch`, branch off the FRESH trunk head, named per convention; a dirty tree is never stashed. A
panel group already sits on its own branch — keep it.
**Gate:** `git branch --show-current` is the ticket's branch, tree clean, branch point = trunk head.

## 3. Decompose before the first edit

Expected result as checkable statements, each a future §10 row, ≥1 negative; tier per §Tier; profile
picked once (profiles.md) and its page read before §4 — references/profile-design.md,
references/profile-frontend.md, references/profile-backend.md, references/profile-fullstack.md; an
MR with reviewer threads runs the follow-up mode instead.
**Gate:** `03-plan` names the tier with its markers (and the T3 lift that fired), the profile, a
verification method per item.

## 4. BEFORE shots — before the first edit

Visible change only; one `BEFORE|AFTER` script; one pair per touched screen. Nothing uploaded before §8.
**Gate:** BEFORE files on disk and the logged text matches the reported defect.

## 5. Fix

The package's idiom; i18n in every locale; docs in the change or `Docs-Impact: none — <why>`; the
backend checklist item by item; narrow checks only. Last acts: the six-classes row, then
`agentdeck-kit:style-conformance-review` over the whole diff (review.md §Style self-review).
**Gate:** narrow checks green, the `classes` row written, the style pass reported.

## 9. Review — sized by the tier

Per the table. Findings are claims — **each verified at its `file:line` before any fix**, swept for
siblings, fixed with narrow checks. A panel review stage follows → `09-review skip "panel review
stage"`. `mustfail` ONCE, per the table. Then commit locally (review.md).
**Gate:** every finding `confirmed → fixed` or `rejected → why`, plus **raised N · confirmed M · rejected K**; each fix named with its test and `mustfail` verdict or recorded as visual-only.

## 10. Live run — with the AFTER shots of §7 in the same walk

Per the table; the verdict is the printed acceptance table on the head sha, shown red once (live-run.md).
A bug found here → fixed, narrow checks, only the touched rows retested.
**Gate:** the table printed with zero failures, ≥1 negative row, the variation and walked rows the
tier owes; the `10-live` note names sha, own PIDs/ports, created entities.

## 7. AFTER shots — same walk as §10

**Gate:** the logged DOM text now matches the expected result.

## 6. The gate — ONE run on the final tree, right before the push

Exactly what CI runs, never invented. A project gate tool from the facts IS the gate (gates.md);
otherwise `node <kit>/tools/gate-run.mjs --affected --ticket <KEY> "<name>=<CI command>" …` (the
call: gates.md), T3 → `--full`. The runner writes `06-gates` from REAL exit codes; an autofix is not the verdict.
Re-run only after an edit. Not runnable locally → CI's image, never `skip`. **Red blocks** the push.
**Gate:** verdict green and the matching `06-gates — ok` row written by the runner.

## 8. Push, MR — in one sitting

Commit per artifacts.md; push; draft MR with the FULL description from the ledger, read back, then
out of draft — one sitting. The tracker gets the **MR URL only**.
**Gate:** commit in `git log -1`, the push names the remote branch, the MR passed the read-back, the
ticket shows exactly one link.

## 11. Pipeline — not read; the target, only on a conflict

`11-pipeline skip "not read"`. A conflict with the target → `fetch` + `rebase`, the touched
packages' checks, `push --force-with-lease`. No conflict → nothing, however far the trunk moved.
**Gate:** the `11-pipeline` row; a conflict, if any, cleared and pushed.

## 12. Finish: ticket to review, QA instructions

The review move and the QA comment from the ledger, read back, gated on §9 + §10 only. Human threads
only when the MR pre-existed or one arrived (review.md). **Everything past review still asks.**
**Gate:** MR out of draft; tracker shows review and the read-back QA comment.

## 13. Cleanup — same turn, nothing left running

Kill what THIS ticket started (by the `10-live` PID/port), delete what it created on a shared stand.
**Gate:** a ledger line naming what died (port now closed), what was deleted by id, what was kept.

## 14. Report — then the task is DONE

In the user's language, short, per artifacts.md §Final report, the tier named. Every absent piece
and everything NOT verified is named with its reason. Self-check first: stages.md §Red flags. After
it only a reviewer thread or a target conflict reopens the task.

## Notes, not blockers

A LIVE sieve that cannot run here (contract-by-request, browser-focus, boundary-negative,
migration-safety, branch-backend-stand — no stand, no browser, no network) and a red not caused by
the branch (red on the target branch too, platform-only, a timeout in code the diff does not touch)
do not stop the ticket: report them as `not checked: <reason>` / `not caused by the branch: <why>`,
record a Tests-block case that cannot run as `blocked` with the reason, and name each in the MR
description. The MR is ready with them. Any other sieve runs locally: `not checked:` does not waive
it. A split group asks the human ONLY for: a merge; a deletion (any git deletion, or anything
outside its copy); a force-push beyond the §11 lease; a DB migration, DDL or data write; credentials
that exist nowhere in the project. The other items below a group resolves itself: a dirty tree →
finish and commit its own edits first; a result still ambiguous → decide by the plan and name the
decision in the MR description; the same gate red a third time → the panel's escalation, then stop
with the reason; a dependency/CI/build change no finding needs → do not make it.

## Stop and ask — do not improvise

Binding as is outside a split group (solo delivery); a split group follows the paragraph above.

- The ticket is assigned to someone else, or already in progress elsewhere.
- The working tree is dirty at §2.
- The fix needs a DB migration, DDL or any data write.
- The expected result is still ambiguous after every comment.
- The same gate is red a third time on the same cause.
- A second infrastructure death on the same CI job.
- Anything that would need a merge, a deletion, or a force-push beyond the §11 lease.
- Before touching a dependency, CI image or build config no confirmed finding needs.
