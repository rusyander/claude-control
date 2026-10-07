# Ledger, stages §1–§5 and §13, red flags — the detail behind each gate

Stages with a page of their own: §6/§11 gates.md · §9 review.md · §10 live-run.md · §7/§8/§12/§14
texts artifacts.md.

## Ledger statuses

`ok` · `red` (attempt recorded, stage still open) · `skip` (not applicable, say why) · `stop`
(halted with a question; halts only while it is the last line). No tracker key → a slug is the key. A ledger filled in one sitting at the
end is a story, not evidence — `add` says so itself from the fourth stage stamped in one minute.

**One `add` per stage, as that stage's last act** — the next stage starts after it, never before.
A stage whose moment passed unrecorded (crash, stop, resume) is written from its ORIGINAL evidence —
the command output, sha and time it ran — with the note `late`; no evidence left → re-run the stage.
Stage ids are the canonical ones `check` prints (`07-after`, `12-finish`), never a local synonym.

## §1 Read the task, classify by CODE, claim it

Body and every comment — a returned ticket carries the QA reason there — then locate the defect in
code. **The classification comes from the code, not the description.** Read-only first:
`node <kit>/tools/ticket-preflight.mjs <keys>`; a `STOP` line means nothing is claimed. **The
claim is the FIRST write of the run**: held by somebody else → not mine, `stop`, name who holds it;
unassigned → assign to me, move to in-progress. Status is not a claim, only the assignee is.

This is also the ONE place the design question may be asked, bundled with any other fork question:
"should it be checked against the mock?". Asked once, here, or never — review.md §Design re-check.
Same bundle, same rule: the code classification puts the fix in backend (Go/Python/SQL/Helm/CI) →
"the fix needs backend edits in <files> — may I?". Yes → granted for THIS ticket; no → frontend only,
backend named at `file:line` in the report and the ledger. Backend found only later → finish the
rest, then ask once (kit safety rules).

## §2 Pre-flight, then branch

`git status --short` empty — a dirty tree stops the run, never stashed silently. `git fetch`, branch
off the FRESH trunk head. The project's written convention names it; none → `<type>-<KEY>/<slug>`,
several keys comma-separated after the one prefix, no ticket → `<type>/<slug>`.

## §3 Decompose before the first edit

A numbered plan in the ledger: file → what changes → how it is verified. The expected result becomes
**checkable statements**, each a future row of the §10 table, at least one negative. Ambiguous after
every comment → ask NOW. `node <kit>/tools/risk-tier.mjs` prints T0/T1/T2 and the blast radius —
consumers §9 owes a verdict each, entry points §10 a walk each, capped by tier, the rest named.
Budget 2–3× a plain run, never 10×.

## §4 BEFORE shots

Visible change only. Unrecoverable later: an AFTER with no BEFORE is one-sided and is reported as
one. One script taking `BEFORE|AFTER`, output into `.agent/screenshots/before-after/<key>-<slug>/`,
asserting the defect text from the DOM and logging it — that line is the evidence the shot is of the
right thing.

## §5 Fix

The package's own idiom wins. i18n strings land in every locale at once. Docs ship inside the
change; nothing needed → `Docs-Impact: none — <reason>` in the commit message, never silence.
Backend half, item by item: validation before the service layer, error mapping, existence plus
ownership, nothing silently ignored, a declared right on every new route, contract first with the
drift fixed in the same MR, l10n, counters. The project's backend canon (`docs/rules/<lang>.md`,
`*STANDARDS*.md`, CLAUDE.md checklists) first; `<kit>/skills/deep-review/references/backend.md`
is the floor under it — its sweep runs over your own added lines before §6.

Before calling the fix done, the six classes human reviewers keep catching
(`<kit>/skills/deep-review/references/axis-1.md` §Six miss classes) are asked of your own diff:
every sibling of the defect you fixed, every other consumer of what you changed (and of any new
error code or field you emit), the request that hangs, work placed before its gate, an environment
dependency, spec ↔ validator. The answers are one ledger row `classes` — per class the grep run or
the `file:line` read, «n/a» with the search that shows it; a row without them is a story.

## §13 Cleanup — same turn, nothing left running

Kill what THIS ticket started and nothing else: dev servers, watchers and tunnels started here, the
two §9 subagents, one-off containers, data seeded for the walk, the throwaway probes from §10 —
leaving the shots script and the folder README. Always kept: images, named volumes, models, caches,
and any stand the user was already running. Unsure → keep it and say so.

**Own stand, proved closed.** A dev server started for this ticket has its PID and port in the
`10-live` note; §13 stops exactly that PID and proves the port no longer listens
(`netstat -ano | findstr :<port>` / `lsof -i :<port>` empty). A server the ledger cannot name is
not killed on a guess — it is listed as kept, with its port.

**Shared stand, own entities deleted.** Everything the walk created on a stand others use (a
provider, user, chat, record) is named `qa-<KEY>-<what>` at creation so it is findable, its id goes
into the `10-live` note, and §13 deletes it through the same API or UI that created it, then reads
the list back to confirm it is gone. A delete the guard or a missing right blocks is a ledger line
and a report line with the id — the rest of the run goes on; cleanup of own artefacts is never a
question to the user.

**Scratch stays in the worktree.** Probes, sessions and shots go under THIS worktree's root
(`<worktree>/.agent/tmp`, `<worktree>/e2e/...`), never the main checkout — a path resolved from
memory of the main clone is the leak.

## Red flags — post-hoc, before the §14 report

- Code written while the ticket is still unassigned.
- An autofix, or a hand-typed `06-gates` row, reported as the gate — exit codes nobody saw.
- An acceptance table with no negative row, or a live run reported without one.
- An AFTER shot shipped when BEFORE was never captured, without saying so.
- A review finding fixed before it was verified at `file:line`.
- "Verified" in the MR when only the gates ran and the live walk did not.
- A piece missing from the environment left out of the report.
- The ledger written at the end in one go.
- Shipped on a red gate «with an escape planned»; `11-pipeline ok` on a running pipeline.
- A finished run parked on «undraft — your decision»; a test entity or dev server left behind.
