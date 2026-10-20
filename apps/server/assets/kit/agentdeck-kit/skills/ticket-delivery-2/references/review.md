# §9 — one deep review, the design re-check, the proof

## Sizing — one `deep-review` per task, it sizes itself

- **T0 trivial** (copy, spacing, typo; nothing behaviour-bearing) → no review. The author answers the
  surface list (placement, canon, i18n in every locale, docs surface, the radius) as ONE ledger row
  `09-review ok "T0 self: …"`, each item with its grep or `file:line`.
- **Everything else** → the `deep-review` skill, invoked ONCE, own-code mode, scope = the branch diff.
  Hand it the §3 tier, the radius rows and the profile lens (`frontend.md` / `backend.md` /
  `data-deploy.md`) as hints; the agent count, lanes and rounds are ITS decision (its `lanes.md`),
  never fixed here. Its fix loop is the §9 fix loop; a review fix never triggers a second review.
- The panel's prompt says a review stage of its own follows → no spawn here,
  `09-review skip "panel review stage"`; that stage's findings are handled per §Findings below.
- **T3** → the same single `deep-review`, plus a cold re-check of every CONFIRMED finding's fix by a
  fresh verifier (`deep-review verify …`, lane-high) before §10 — the author verifying their own fix
  is the blind spot T3 pays to remove. Still one review; the verify pass reads only the fix delta
  (`git diff <reviewed-sha>..HEAD`, per file), never the whole diff again.
- `deep-review` absent (discovery.md) → the fallback below: one agent at T1, two at T2/T3, named in
  the report as the reduced review.

Spawn `description` tags follow deep-review's own (`deep-review r<N> …`, `deep-review verify …`),
all lane-high; the 40-per-session review cap counts them.

## Fallback without `deep-review` — reduced, named as such

Each prompt is English, names the tier and the radius rows that agent owes, points at the project's
own rules files by absolute path, says «Read-only: edit no file — findings only», and carries these
two blocks **verbatim** — a spawn without them is denied:

```
[return-format] Return <=10 lines, compressed English: outcome, key facts, paths. Longer deliverable
(plan/report/spec/findings) → write it to .agent/tmp/<task>.md and return the path + a <=10-line digest.
[no-subagents] You must not spawn subagents of your own: no Agent, Task or Workflow calls, whatever the
task size. Do the work yourself in this context and report back.
```

T1 → ONE agent: the frame first (where this has to live, who else renders or calls it — answered
before the diff is opened; an agent that opens the diff first never comes back to the frame), then the
diff — logic, regressions, edge cases, error mapping, contract drift, ownership, permissions — then
the six miss classes of `deep-review/references/axis-1.md`, one line each with its command or
`file:line`. T2 → two agents, two ENTRY POINTS: **A** from the diff (correctness + siblings, hang,
before the gate, environment), **B** from the frame (canon, placement, i18n, a11y, docs surface,
parity both ways, contract ↔ validator). Every radius row comes back as `checked at file:line`,
`unaffected, because …` or `not checked`; couplings the import graph cannot see (i18n keys, query
keys, routes, permission strings) are grepped by hand, once per changed literal.

## Findings are claims, not facts

Verify each at its `file:line` yourself before fixing anything: a review agent that has not run the
code produces false positives, and a fix applied to one costs more than the finding was worth. Each
confirmed one is then swept for siblings — the same shape in the same function, file and parallel
handler — before its fix: a human reviewer finds the second copy otherwise. Merge the reports, drop
duplicates, record a verdict per finding, and end with one summary line —
**raised N · confirmed M · rejected K**. Fixes take narrow checks only (SKILL.md §Working
discipline); the full gate is §6.

## Rejected claims — the evidence is the answer, the scope stays

A claim — from a review agent or a human thread — that does not reproduce is rejected WITH its
evidence: the probe run, its red-capable control included, quoted in the reply; the probe itself
stays in `<worktree>/.agent/tmp`. Scope does not grow to keep a test for it: a new dependency, CI
image, browser runner or build-config rewrite that no CONFIRMED finding needs is a separate proposal
in the report, recommended no, asked before its first edit (SKILL.md §Stop and ask). One run added two
devDeps, +1858 lockfile lines and a CI image change to keep a test for a claim that did not reproduce.

## Human threads — read when they can exist (§12), and after the task closes

A fresh MR opened at §8 and taken out of draft in the same sitting has no human thread to read. Read
the discussions — ONE list call, unresolved human threads only — when the MR pre-existed this run (a
returned ticket, a resumed run) or a thread arrived during it. Each thread: confirmed → fixed, the
touched packages' checks, the touched spot retested, pushed, answered (rule `published-text` §Review
replies); rejected → answered with the counter-evidence (above). `12-finish` names the count read and
the thread ids handled. A thread that lands after the task is DONE reopens it the same way, and only
it.

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

## Style self-review — every run, no question, at the end of §5

Not part of the design re-check. `agentdeck-kit:style-conformance-review` runs over the whole diff as
the last act of §5, before §9 — the reviewer then reads code that already matches the team's profile
instead of reporting style. Its Phase 0 refreshes the profile from reviewer remarks only when the
harvest is older than 7 days (that skill's own rule). Style asks recur on almost every front MR and
none was caught before review (one real team over a month: ~17 style asks + 7 stale comments among
103 human notes). Its fixes are pure refactors → narrow checks; a §9 fix does not re-run the pass, its
own lines follow the profile. The report carries one line — checked N files, fixed K, profile rules
added M.

## A defect that was not caught by a test gets one

A real bug — from the review or from §10 — means a test that is red before the fix and green after,
in the package's own idiom. Proved rather than asserted: the revert has to break it. `mustfail` runs
ONCE, after the §9 fixes, batched over every bug-fixed file; T2 adds the change's behaviour-bearing
files that carry a marker; T3 takes every behaviour-bearing file of the diff. A bug found later in
§10 adds one call over its own file only. A verdict is memoised per tree — never proved twice.

```bash
node <kit>/tools/mustfail.mjs --cmd "<the project's test command>" --files <fixed1>,<fixed2>
```

GREEN there means the suite does not actually cover that file, and it may not be quoted as evidence.
Purely visual regressions are covered by the before/after shots instead, and that is recorded as such.

Everything confirmed is fixed HERE, before the live run, with narrow checks; then a local commit —
the one handoff point (artifacts.md §Handoff). The full gate is §6, once, after §10.
