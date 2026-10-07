# Review depth — a change is about to be reviewed, or a review is about to be published

How much to check is `verification-depth.md` (`risk-tier.mjs`). This is how a review is conducted and
what it may not be published without.

## Open with the baseline, or every finding is about the wrong tree

The first line of any review names **base sha · reviewed head sha · current head sha**, and the
branches its dependencies live on. Three separate failures all come from skipping it: reasoning
against `main` while the feature depends on an unmerged branch; a head that moved under the review
(a bot commit, a force-push) so the published line numbers point elsewhere; a "red CI" claim about a
pipeline that ran on a different sha. A reviewed head that is no longer the MR head is stated as
such, not silently re-based.

Get it from the forge, not from guesswork: versions give all three shas; a red job is classified by
`failure_reason` and its **log is readable** — `list_pipeline_jobs` then `get_pipeline_job_output`.
Before calling any forge tool "missing", run `discover_tools`: whole categories (pipelines, ci, wiki)
are opt-in and absent from the session until activated. A capability declared missing without that
check is a wrong claim about the environment.

## The description is an object of review, not the frame alone

Every factual claim an author makes — "behaviour unchanged", "the backend already sorts this",
"covered by the existing test" — is a testable assertion, and the ones that read most convincingly
are the ones that get believed without checking. Each is confirmed at `file:line` or named as
unverified. A claim that survives review unchecked is how a defect reaches production carrying a
reviewer's approval.

## Moving code is not reviewing it

An extraction pass — a body lifted into its own file, a helper renamed, a page split — proves
PLACEMENT and nothing else. The body rides across unread while every mechanical check stays green
over it: placement kinds, `@covers`, prettier and the type graph all see a file that moved, not a
shape that was never examined. So whatever a pass touches, its body gets one read on its own terms —
nesting, branching, an iteration inside an iteration, a ternary deciding what to accumulate — before
the pass is called done. In one real MR a nested accumulation loop was carried into
`utils/mergeInitiators/` verbatim by the review commit itself, passed three gates, and was named by
the human reviewer instead.

## Two reviewers means two entry points, never two copies

Running the same pass twice buys correlated findings and a shared blind spot. Independence comes from
where each pass _starts_:

- **from the diff** — logic, edge cases, regressions in what the changed symbols touch elsewhere;
- **from the frame** — ticket, spec and contract first, the diff opened only afterwards, asking where
  this must live and who else renders or calls it. This is the pass that finds the screen nobody
  changed and the requirement quietly dropped;
- **from the runtime** — run it, then read the code along the path just walked.

Findings both passes reach independently are the ones most likely real. Merging drops duplicates; it
does not average severities.

## The radius is the review's worklist, not a footnote

`risk-tier.mjs` prints the blast radius under the tier: every consumer of a changed export, followed
through barrels up to the entry points, capped by the tier (12 rows at T1, 25 at T2). Each printed
consumer gets **one verdict row** in the report — `checked at file:line` · `unaffected, because …` ·
`not checked` — and the `**Radius:**` header line carries the totals. Rows over the cap are listed as
not covered, never dropped: the cap is the time budget, and what it cut is part of the result.
The section **line consumers** (names, test ids, routes, i18n keys the diff removed or renamed that are still
read outside it, e2e and QA included) owes the same one verdict per row: a removed name still read is a
break until a row says why not. Its search stops at 60 tokens; each token in the "NOT SEARCHED" tail owes a
verdict too — a manual `git grep -wF <token>` or a `--paths <zone>` rerun per zone. The printed rows are not the whole set.

The import graph sees only imports. Everything that couples through **text** — an i18n or query key, a
route path, an event, channel or permission name, a feature flag, a CSS class or custom property, a
contract field — is the change whose import radius prints empty, and the same run now covers it: every
literal the diff added OR removed is looked up repo-wide and printed under "STRING COUPLINGS", scarcest
match first. The filter is scarcity, not a vocabulary of key shapes — a string nothing else names is
not a coupling, one that forty files name is vocabulary. Except an ADDED code-shaped literal in a
producer position (an error being built, a contract or spec file): zero readers outside the change is
exactly the defect — the client that should map it was never touched. Those print under "NEW STRINGS
WITHOUT A CONSUMER", one verdict row each: who reads it, or why no reader is needed.

Those rows are worklist rows like any other: each owes a verdict. A removed literal still named
elsewhere is the strongest of them — that file is now talking to nobody, and no import edge says so.

## Publishing — re-read, then dedup, then write

Immediately before the first write, fetch the discussions again and diff your findings against what
is already there. Reviews arrive while yours is being written, and a note listing a finding a human
posted forty minutes earlier costs more trust than the finding was worth. A stale list is the normal
case, not the exception: the read that opened the review is not the read that licenses the write.

Every write still waits for one explicit confirmation naming the batch. Never resolve a thread, never
approve, never merge.

## The kill rate is the number worth keeping

Record three per review: **raised · published · confirmed by the author**. Candidates that died under
proof are the review's most informative output — four dropped for one published is a healthy pass,
and a reviewer with nothing ever dropped is not verifying. Without the counts the bar cannot be tuned
in either direction, and a review that is mostly rejected quietly stops being read.
