# Evidence — producing the three kinds, and killing a candidate fairly

A 🔴 or 🟡 carries at least one, strongest first. A 🟢 needs none: the reader can see a nit. Which rung
of the ladder a claim needs, and the recipes: [live-proof.md](live-proof.md).

## The gate — cheapest first, and easy to misread

It runs before the first finding as evidence-gathering. Read its **exit status**, not its stdout:
behind a pipe a failing gate reports success. What it prints is the gate's finding, not yours, and a
red gate is finding one — unless red for a reason outside the scope, which is stated and set aside. A
gate whose file list is built from the wrong range is a finding about the gate: reproduce both ranges
before attributing its output to the change under review.

## Run it

Call the function, script or endpoint with the exact input and quote the real output. Reach for
whatever the repo already runs — `node -e`, `go test -run`, `python -c`, `psql -c`, a `curl` at the
endpoint, the project's own runner on a scratch case.

**A fix is proved by its own failure.** Run the broken case at the base commit, then at the head. One
you could not make fail beforehand is unverified, and so is the test shipped with it.

**Scratch cases live outside the repository.** The working tree someone else is committing into gains
nothing. Build the harness in the scratch dir and point it at the code under review — a throwaway
project with a path dependency: `replace` in a temporary `go.mod` (or `go test -overlay`), a `file:`
dependency in `package.json`, `pip install -e`, a `path = ` entry in `Cargo.toml`.

**Configuration is a lever.** A defect on a 15-minute timer is provable in 250 ms: build the object
with the smallest config that keeps the shape of the bug, and say what the production numbers make of
it. A promise stated AT a number (revocation within N s) is proved at that number — virtual time
(`synctest`, fake timers) or a measured run.

**Mutate the changed code, then ask the whole suite.** One mutant per promise the diff makes — the
guard negated, the call deleted, an early return, the constant ±1 — with an identity control that must
survive first. A survivor on a guard, auth, mask or limit line is 🟡 "no test holds this promise",
the mutant its repro. `review-sweep mutants` writes the plan over the changed lines; a mutant it
cannot shape (a deleted call) is added by hand. Commands: [live-proof.md](live-proof.md) §L1.

**Straddle the diff's literals.** A refactor or a pure function gets `head(x) == base(x)` over a
generator seeded with every numeric and string literal in the diff ±1, plus empty and max — random
strings up to 200 never reach a 10000-char threshold; seeded, it fell in 0.13 s. A test file the MR
changed: run BASE's version against HEAD; newly red = an expectation edited away, and the MR says why
or it is the finding.

**A change to a check is checked by its blind spot.** The diff touches a CI gate, mock, fixture or
harness: build the input where the gate is green and production red. It exists → 🔴.

**The harness is a deliverable.** The case that proved a finding is the regression test the fix needs
— hand it over with the report, in the project's test idiom.

## Cite it

`file:line` of the line that proves the claim: the caller that breaks, the doc that promises
otherwise, the config that contradicts. Reading the called code is part of citing it — "no error
handling here" is wrong when the mutation's `onError` has it. The strongest citation is the repository
contradicting itself: a doc comment describing the very failure the code exhibits, a sibling module
doing it correctly.

## Search it

"No other caller passes X" is a claim about the whole repository — show the grep, with its command
line and its count. A zero result is evidence too: _nothing_ imports this package is a finding about
the frame, not an absence of findings.

## A kill is a claim — symmetric proof

A candidate is struck only by a defence shown at `file:line` on **every path its thesis spans**:
write and read, each consumer the radius lists, each exit of the promise pass, each role of the
matrix. The `- ✗` line names the paths it covered:

```markdown
- ✗ "files leak to another tenant" — dropped: `tenant_id` filter on write `repo/files.go:41`, on
  read `repo/files.go:97`, in export `export/zip.go:55`; consumers 3 of 3
```

What keeps it alive as ❓: a check of one side only, an empty grep with no command shown, a defence
inferred from a function's name, «the framework handles it» without the line where it does. !778: the
RBAC candidate was struck after checking that enabling storage required the permission; reading the
content did not, and it was 🔴.

## A clean verdict against a specification

"No discrepancies" is the hardest verdict to earn, because the check that produces it is the one most
likely to be incapable of producing anything else. It counts only when both directions ran:

- **authority → artifact** — everything the spec demands is present and equal. Catches the unfinished.
- **artifact → authority** — everything the artifact changed was authorised. Catches the invented.

The allowed set for the second direction is built from exactly the rows that GRANT permission.
PROJ-944: built from "the token name appears anywhere in the spec" it was a superset — names also appear
in tables that authorise nothing — so the check could only confirm; rebuilt from the three token tables
alone, it named a variable changed outside the changelog on the first run.

A script written for the review is unverified code whose bugs all run green. Feed it a value that MUST
fail and watch it go red before quoting its output; quote what it printed, never a number from memory.
