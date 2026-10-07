# §9 — the two review agents, the design re-check, the proof

Two agents means two ENTRY POINTS. The same prompt twice buys correlated findings and one shared
blind spot; half the files each buys two shallow passes. Depth is 1: neither may spawn its own.

## The prompts

Each prompt is English, names the tier and the radius rows that agent owes, points at the project's
own rules files by absolute path, says «Read-only: edit no file — findings only», and carries these
two blocks **verbatim** — a spawn without them is denied:

```
[return-format] Return <=10 lines, compressed English: outcome, key facts, paths. Longer deliverable
(plan/report/spec/findings) → write it to .agent/tmp/<task>.md and return the path + a <=10-line digest.
[no-subagents] You must not spawn subagents of your own: no Agent, Task or Workflow calls, whatever the
task size. Do the work yourself in this context and report back.
```

**A — from the diff, correctness.** Start at `git diff <base>...HEAD`. Logic, regressions, edge
cases, error mapping and status codes (a 5xx for a client error is a bug), contract drift, existence
plus ownership checks, permissions, parsed-but-unused fields, counters and aggregates. Then four
classes of `<kit>/skills/deep-review/references/axis-1.md` §Six miss classes — siblings, hang,
before the gate, environment — each answered in one line carrying the command run or the `file:line`
read («n/a» names the search that shows it); a backend diff also runs the sweep of
`<kit>/skills/deep-review/references/backend.md`. Owed rows: the consumers of the §3 radius.

**B — from the frame, canon and surface.** Start at the ticket, the spec and the package rules, and
answer where this has to live and who else renders or calls it BEFORE opening the diff. Then
layering and import direction, code standards, file placement, decomposition, i18n in every locale,
accessibility, form/modal/table patterns, the docs surface. This is the pass that finds the third
screen nobody changed; reading the diff harder never finds it. Owns the other two classes, same
one-line answers: parity both ways (every other caller of a changed endpoint or mutation handles what
the new one handles; every new error code, enum member or field reaches each consumer map) and
contract ↔ validator, field by field — both need the frame, not the diff.

Every radius row comes back as `checked at file:line`, `unaffected, because …` or `not checked`.
Couplings the import graph cannot see — i18n keys, query keys, routes, permission strings — are
grepped by hand, once per changed literal.

## Findings are claims, not facts

Verify each at its `file:line` yourself before fixing anything: a review agent that has not run the
code produces false positives, and a fix applied to one costs more than the finding was worth. Each
confirmed one is then swept for siblings — the same shape in the same function, file and parallel
handler — before its fix: a human reviewer finds the second copy otherwise. Merge
the two reports, drop duplicates, record a verdict per finding, and end with one summary line —
**raised N · confirmed M · rejected K**.

## Rejected claims — the evidence is the answer, the scope stays

A claim — from a review agent or a human thread — that does not reproduce is rejected WITH its
evidence: the probe run, its red-capable control included, quoted in the reply; the probe itself
stays in `<worktree>/.agent/tmp`. Scope does not grow to keep a test for it: a new dependency, CI
image, browser runner or build-config rewrite that no CONFIRMED finding needs is a separate proposal
in the report, recommended no, asked before its first edit (SKILL.md §Stop and ask). One run added two
devDeps, +1858 lockfile lines and a CI image change to keep a test for a claim that did not reproduce.

## Human threads — re-read as the last act before the undraft (§12)

Reviewers post while the run is still going, and a thread that lands after the run closes reaches
nobody. So right before the §12 undraft — and again after any push made to answer one — list the MR
discussions from the forge and take every unresolved human thread: confirmed → fixed, §6, the touched
spot retested, then answered (rule `published-text` §Review replies); rejected → answered with the
counter-evidence (above). The undraft happens at 0 unresolved; `12-finish` names the count read and
the thread ids handled. A blocking thread posted minutes before a group closed once stayed unread.

## Design re-check — OFF by default, one question at §1

**One question, at the start of the run, or none at all.** At §1, alongside any other fork question,
the design question may be asked once: "should it be checked against the mock?". It also counts as
asked when the user's own words already carry it — "match the mock", "check the design", a design link handed
over with the task. A user-visible change and an existing mock are NOT triggers by themselves.

"No", no answer, or the question never asked ⇒ **nothing anywhere for the rest of the run**: no
second question later, no ledger row, no "not checked: no mock" line in the report, no
mention that the option exists. Silence is the correct output, and a report that names the unrun
design check is the defect this rule prevents.

"Yes" ⇒ run it inside §9, before the live walk, so findings merge into the same ledger rows and are
fixed before §10 walks the screen. `agentdeck-kit:figma-parity` is invoked, not restated here — statics, states and
motion, one to one against the mock. Address the node by id or by the frame URL from the task; render
it into the shot folder once and compare against that file rather than re-fetching.

Asked for but impossible (no mock reachable, Figma MCP not attached) ⇒ say so in one line and stop
there; that report line exists because the user asked, not because the step exists.

## Style self-review — every run, no question

Not part of the design re-check. After the §9 fixes are green, `agentdeck-kit:style-conformance-review` runs over the
whole diff, subagents' edits included: its Phase 0 pulls reviewer remarks into the profile first, so
the pass checks what this team's reviewers actually ask for. Style asks recur on almost every front MR
and none was caught before review (one real team over a month: ~17 style asks + 7 stale comments
among 103 human notes). Its fixes are pure
refactors → §6 re-run; the report carries one line — checked N files, fixed K, profile rules added M.

## A defect that was not caught by a test gets one

A real bug — from the review or from §10 — means a test that is red before the fix and green after,
in the package's own idiom. Proved rather than asserted: the revert has to break it.

```bash
node <kit>/tools/mustfail.mjs --cmd "<the project's test command>" --files <path to the fixed file>
```

GREEN there means the suite does not actually cover that file, and it may not be quoted as evidence.
At T2 run it over the whole change, not just the fixed file. Purely visual regressions are covered
by the before/after shots instead, and that is recorded as such.

Everything confirmed is fixed HERE, before the live run; then the §6 gates run again.
