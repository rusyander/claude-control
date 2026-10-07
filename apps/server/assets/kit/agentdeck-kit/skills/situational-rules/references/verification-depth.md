# Verification depth — a test is being written, or a check is about to run

The invariant sits in CLAUDE.md; this is how to hold to it.

## The budget ladder — effort follows blast radius, never diff size

Both failures cost trust: a copy fix dragging a two-hour protocol behind it, and an RBAC change waved
through because the diff was three lines. So the tier is **computed before the first check** and
printed with the evidence that produced it:

```
node <kit>/tools/risk-tier.mjs [--base origin/main]
```

- **T0 glance** — nothing behaviour-bearing changed. Gate only; no live run. Say in one line why T0.
- **T1 standard** — the default. Gate · every touched symbol followed to its other call sites · one
  live positive and one live negative · red-before/green-after on any bug fixed.
- **T2 hard** — any single marker lifts the whole change: access and ownership · money and counters ·
  schema or contract · concurrency · irreversible writes · a changed behaviour-bearing file with no
  test beside it. T1 plus `mustfail`, two review entry points, two live variations, both-directions
  parity where an authority exists.

One marker is enough — markers do not average out, because the cost of the defect does not.
Disagreeing with a computed T2 is allowed and stated out loud with the reason; silently working at a
lower tier is not.

The same run prints the **blast radius** — consumers of every changed export, followed to the entry
points — and the tier caps it: T1 12 review rows / 3 live entries, T2 25 / 6; a hub with over 25
importers is sampled at 3. The caps ARE the budget: what falls outside is printed as not covered, and
the report says so instead of implying the whole project was read. `--explain` shows the chains,
`--no-radius` skips the radius only. **Line consumers** (removed/renamed names, test ids, routes, i18n keys
still read outside the diff) print at every tier and under `--no-radius` too — the one consumer class the
import graph cannot see; past 60 tokens the rest is named as "NOT SEARCHED" and owes a manual grep.

## The substitution boundary

Substitute ONLY what a test cannot have: the network socket, the clock, the filesystem, an external
paid API, a stand that is down. Everything between the entry point and that boundary runs for real —
the library version that actually ships, the framework's own wrapping, the error path in the shape it
actually arrives. Case: `httpx.MockTransport` under the SDK is a boundary
substitution; calling `_classify_error` with a hand-built exception replaces the subject itself.

## The proxy trap — three shapes, all green, all proving nothing

- a table of hand-built inputs fed straight to the unit — proves the table, not that anything in the
  system ever produces those inputs;
- the mock asserted instead of the effect — proves the call happened, not that it did anything;
- a wrapper or entry point exercised that the product never goes through.

Ask of a finished check: **what would have to break for this to go red?** If the answer is not the
defect itself, the check is decoration.

## Data against a specification — both directions

Checking values against an authority (design changelog, OpenAPI contract, acceptance table) is two
checks: **authority → artifact** (everything demanded is present and equal — catches the unfinished)
and **artifact → authority** (everything changed was authorised — catches the invented: the colour
nobody asked for, the renamed key, the dropped token). The allowed set for the second is built from
exactly the rows that GRANT permission, never a looser source. A parity script built from "the name appears
anywhere in the spec" could only ever confirm; rebuilt from the three token tables alone it named a
variable changed outside the changelog on the first run.

## The checking script is unverified code, and its bugs run green

Each bug of an ad-hoc parity script — a partial parse, a too-wide reference set, a silent undefined —
makes the result greener. Before trusting a green run, feed it a value that MUST fail and watch it go
red. A non-zero missing / skipped / unparsed count is a failure whatever the summary line says, and a
number the run did not print is never reported (a "200/200" was once quoted from memory while the
script printed four misses of its own making).

The mirror bug makes a harness all RED. A mutation run carries a control — an identity mutant that
must SURVIVE — or "11/11 killed" may mean the tool never ran: `new URL(...).pathname` keeps `%7E` from
a Windows short path (`RUSYAN~1`), so every mutant "died" of file-not-found. Use
`fileURLToPath`, and read WHICH test failed per mutant: the targeted one, not the first in the file.

## Proof, not conviction

A fix ships with the defect reproduced on the OLD code first — red-before, green-after, same command,
same tree. A check that cannot be made to fail on the pre-fix tree is reported as exactly that, never
counted as passing. Where the pre-fix tree is reachable, the red half is a command, not a memory:

```
node <kit>/tools/mustfail.mjs --cmd "<the narrowed test command>" [--base HEAD] [--quick]
```

It reverts each changed file to the base revision (default `origin/main`; `--base HEAD` for
uncommitted edits), re-runs the check, and puts the file back; `{file}` in the command narrows each
run to the reverted file (`--cmd "npx vitest related {file} --run"`). GREEN after a revert means that
file's behaviour is untested whatever `@covers` claims — the suite may not be quoted as evidence for
it. Run it at T2, and on any single file whose bug was just fixed.

A new test over UNCHANGED code has no base to fail against: its proof is a planned mutant —
`--mutants plan.json`, each entry a one-line break of the behaviour its named test claims; the tool
runs the identity control itself. Shapes that ship green and the mutant exposing each:
`<kit>/skills/unit-integration-tests/references/weak-tests.md`.

## Someone else's reproduction outranks mine

A reviewer, a QA report or a user who names a scenario has already picked the path that matters:
reproduce through THAT entry point, then leave it behind as a permanent test. A lighter check than the
one that found the defect earns the same comment a second time.

## Live check and report

User-visible change → the real run on the real stand, run by the agent itself; what to exercise →
the `live-check` situational rule (delivered when a browser or stand run starts). Report what was
executed and what that proves — which command, which path, on which tree; what was not verified is
listed as not verified, with the reason.
