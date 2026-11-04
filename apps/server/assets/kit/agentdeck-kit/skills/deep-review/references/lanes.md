# Lanes — several independent readers, one merged ledger

A single reader finds about half of what is there; two independent ones about three quarters. Reading
the same thing twice does not count: an identical rerun re-finds 85% of what the first run found. What
adds recall is a reader forced to BUILD something different — a label alone ("act as a tester") adds
nothing. So a lane is defined by the artifact it owns, and its findings are that artifact's gaps.

## Plan

`review-plan.mjs plan` (command in SKILL §2) sizes by estimated diff tokens, `(bytes + 8·lines)/2.2`.
Code files enter `pack.diff` with their whole enclosing functions (`git diff -W`; `-U15` where that
grows a file by >150 lines), so a lane never Reads the function around a hunk again. A chunk closes at
~400 changed lines or half a round; a lane-round = 95k lane context − 24k base − ≈9.5k brief − 30k
working room ≈ 31k of diff (`--chunk-tokens` / `--round-tokens` override). A data file (a baseline,
lockfile, JSON record array) is one `data` chunk owned by one lane, its key-level added/removed/changed
summary in that lane's brief and whole in `plan/data-<id>.txt`.

Options: `--risk` stores the tier and feeds risk-tier's radius as each CONSUMER chunk's callers outside
the diff (≤15; else `git grep -w` of changed exported symbols, Go `internal/` hits kept inside their
module) · `--tests-record` names the clean-head runs lanes never repeat · `--mr-text` / `--tickets`
embed texts saved to files first (a brief never points at text it does not carry; a non-English
tracker text saved under `.agent/tmp` opens with the language-guard marker `<!-- lang:ru -->`) ·
`--lessons <style profile>` embeds its
«Review lessons» · `--note` carries an owner decision that overrides the brief · `--parity <check>`
makes a translation whose source twin is in the diff TEST-only, row `swept — parity <check>` · `--lint
off` skips the plan-time `review-sweep lint` (semgrep, go vet, staticcheck, ruff over added lines,
seconds; style codes only with `--style`).

`--out` is a DIRECTORY (`plan.json`, `plan.md`, `pack.diff`, `lane-<id>-r<k>.prompt.md`, `.paths`
files); `--out x.json` writes that file with `x.*` sidecars. The tool clones head into
`<scratchpad>/review-<slug>/clone`, links `node_modules` where the lockfile matches, copies an untracked
`go.sum` beside each `go.mod`, and prints `install before the spawn:` for the rest; `--scratch <clone>`
reuses one, `--scratch none` sizes only. Cleanup: `review-plan.mjs clean --scratch <clone>`, never
`rm -rf` (the links point into the real checkout).

**Continuation** (new session, pause, compaction): `review-plan.mjs status --plan <plan.json>` first —
stored tier, lanes, rounds run, the next command; risk-tier and this file are not re-read for them.

## Fleet and waves

Fleet: T0 none · ≤100 files → 2 lanes (A = CONSUMER + SPEC, B = TEST +
AUTHZ, B reading in reverse) · over 100 → 4 (A1 B1 over one zone group, A2 B2 over the other). Every
code chunk is read by two lanes with different artifacts; the plan gives test and translation chunks to
the TEST lane alone, docs and contract chunks to the SPEC lane alone, stylesheets to the CONSUMER lane
alone. The MR text's claims have ONE
owner too, the SPEC lane of their group — the other lane rows them `n/a — SPEC, lane <id>`.

Review agents spawn unasked (the kit delegation rule): one line before the first spawn names the plan's
lane-rounds, waves and `lane-high`. `spawn-cost-guard` passes a tagged `lane-high` spawn — `deep-review
r<k> lane <id>`, `deep-review verify prove-<k>` — 100 per session, the 101st asks. A lane's rounds read
disjoint chunks, so **every lane-round runs at once**: the plan prints waves of ≤6, round-major (r1 of
every lane first); wave 1 goes out in one message, each further lane-round as a slot frees. The spawn
prompt is the stub the plan prints — `Your full brief is <abs path> — Read it first, in one Read.` plus
the `[return-format]` and `[no-subagents]` literals; a brief over 20 KB prints `PROMPT OVER CAP` →
split the round with `--chunks`. Then the orchestrator does its own work that needs no lane (radius
verdicts, gate) and ends the turn with one line in the user's language naming the running lanes; each hand-back wakes
it. A sleep or mtime loop on lane files is refused by `bg-wait-guard`.

Before wave 1: whatever `plan` printed under `install before the spawn:` is installed in the clone once
— a lane never installs. The project's existing tests run ONCE (a Tests block (`.agent/tests/`) →
`tests-cli run --project <repo>`), in the background, into the `--tests-record` file.

**Rounds and RERUN** — `review-plan check --plan <plan.json> <lane files…>`: exit 1 prints `RERUN lane X:
c012 c013… — why` for files without a ledger row AND for every planned round no report header `# Lane
X rK — c…` proves ran. A fresh agent per RERUN line, same artifact, only those chunks, brief from
`review-plan prompt --plan <plan.json> --lane X --chunks c012,c013 --slug <slug> --scope "…"` — never a
hint from a finding elsewhere (a round carrying another lane's findings voids the run's score). Repeat
to exit 0; the `**Ledger:** N/M files · … rounds k of N` line goes into the report verbatim.

## Lane context and tool calls

Each turn re-bills the whole context, so a lane's cost is Σ per-turn context: the peak and the number
of turns both count. The brief prints the lane's cap (≈95k) and the **fan-out** rule: every message
carries all the independent reads and searches of the next step, ≥3 per message while reading; opening
a chunk is ONE message — its pack windows, the callers and enclosing code it needs, a Grep of each
changed symbol. The `lane-budget` hook (`hooks/lib/lane-budget.mjs`, lane subagents only) holds both:
at the cap one line — write the deliverable as it stands, name the unread chunks, hand back (`check`
turns them into RERUN rounds at a small context); 25k past it a firmer line; three single-read turns in
a row → a batch line. An owner note «NO rerun rounds» / «read ALL chunks» silences the cap line.

**Long checks are the orchestrator's, and once.** A lane runs no `mustfail`: its reverts change files
other lanes are reading in the same clone. After the lanes return, the orchestrator runs it once —
vitest/jest: `--cmd "<the package's test script>"` = the critical changed files, each reverted against
ONLY its `@covers` / sibling / own-folder tests (`--trust-green` when the gate just passed, `--budget`
10 min per package; verdicts memoised per tree); other runners: `{tests}` in `--cmd`, else `--quick`
first, per-file only on a red quick — in the background, no `| tail`, woken by the completion notice.
One still running after 30 min is stopped and reported as not finished.

**A message to a running lane names its outcome** — «hand back now» (write the ledger as it stands,
return) or «drop X, continue the rest».

**The orchestrator merges, never reads.** It reads no chunk; a live probe or a dev server is a lane of
its own (`deep-review r<k> probe <cell>`). It keeps lane returns (≤10 lines each), never whole lane
files. **Base comparison needs no second tree**: «was this red on base too?» = the check's error lines
against `git show <base>:<file>`; a `git archive` clone of base only when the check must RUN on base.

## The four artifact lanes

| lane     | owns this artifact                                                                                                                                                                                                          | reads first                                                                         | catches                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CONSUMER | changed symbol → every caller, sibling and parse site → the contract each relies on                                                                                                                                         | the callers outside the diff the brief lists                                        | siblings deviating, parse twice, shared-code severity                     |
| SPEC     | frame line (ticket, epic child, spec, rule doc) and contract claim (schema, API docs, README, help — [axis-2.md](axis-2.md) §h) → code site → request on the stand → status                                                 | the contract and the frame, no hunk before them; then dependency order leaf → entry | docs ≠ code, unwalked acceptance lines, unapplied rule docs, «looks done» |
| TEST     | entry point × trigger grid (restart · recovery · workload / cap N and N+1 · config 0 / empty / unset · sequencing · compatibility · concurrency · twice · never · half-done) × exit × channel, one must-fail input per cell | tests first, then entry points                                                      | promise × exit × channel, config surface, tests that cannot go red        |
| AUTHZ    | role × action × layer (UI guard · route guard · API), plus each trust boundary's attacker                                                                                                                                   | route and permission maps                                                           | RBAC per flow, delegation, the attacker pass                              |

A cell is `clean — file:line` · `finding` · `n/a — why` · `live probe needed`; the lane is done when
no cell is empty, every file of its chunks has a ledger row, and every `## Passes` key is answered. A
lane returning findings without its filled artifact is rerun. A contract cell closes by a request only;
with no stand it is `live probe needed`. **Test bodies are TEST's alone**: test files sit in chunks of
their own, routed to TEST lanes only.

The deliverable — `.agent/tmp/review-<slug>/lane-<id>[-r<k>].md` — opens with the round header (one
Write, then Edit; never echo or a heredoc) and holds the ledger, the artifact table, `## Candidates` in
the C-line shape of SKILL §3, and `## Passes`. **Probe hygiene**: the clone is shared by every lane, so
a probe file is named `zz_lane<id>_r<k>_*` and deleted before hand-back.

## Chunks and windows

One pass reads at most ~400 changed lines plus the context it needs; lines are the recall bound, tokens
the context bound. Each chunk's candidates are written before the next is opened. Read the diff from
`pack.diff` in the line windows the brief lists (each <10k tokens: Read `offset` = first line, `limit`
= length) — never the whole pack, never a grep for `^diff --git` offsets; outside a plan, per file
(`git diff <base> <head> -- <file>`). A persisted `tool-results/*.txt` — a whole MR diff the MCP could
not inline — is read to the last line; a diff taken whole and skimmed by grep is not read, and its
ledger rows are `skipped`.

`review-plan.mjs prompt` prints every brief filled; a changed lane rule goes into the tool (`ARTIFACT`,
`PASS_HINTS`, `promptFor`) and this file together — a brief typed by hand drifts from both. Each lane
sees only its own inputs, never another lane's candidates, until the merge: independence is what the
stopping estimate stands on.

## Merge

`review-merge.mjs merge` (SKILL §5) clusters two candidates when they share a file and lie within ±3
lines with thesis-token Jaccard ≥ 0.3 or ≥ 2 shared input-like backticked spans (`-j 4`, `:::` — bare
identifiers do not count), or share the exact site; a second mechanism at one site rides
along as `also (Mxx.2)` and may come back as its own F-block. Candidate lines it cannot parse are
listed at the end of `merged.md` — read that tail, nothing is dropped silently. Prover briefs are ≤8 KB,
≤6 clusters each (`--max-per-prover`; cost per cluster is U-shaped — every turn carries all earlier
probes, every spawn its own base context: 8 ran 0.6M/cluster, 3–4 cost 23% more than 5); past
`--max-nits 40` the 🟢 split into `prove-nits-<k>`. A prover re-runs a contract finding's request —
re-reading the doc refutes nothing — and returns what the lanes missed in its clusters' code.

**Collapse check:** per lane, u = its unique verified findings / its verified findings. u < 0.2 → that
lane read like another one; next run it gets a different artifact or order, never a plain rerun.

## Stopping estimate — a «keep going» signal, never «done»

`review-plan estimate --n1 <A> --n2 <B> --m <shared> --plan plan.json --pair X,Y` over verified,
deduplicated findings of two lanes reading ONE population — same artifacts, same chunks; the tool
checks. The plan's A × B never do (artifacts differ): m is small by construction, N̂ inflated, and the
line says ADVISORY ONLY and drives no round (Chapman; m ≤ 2 → "coverage unknown, low"). k ≥ 3
lanes: D distinct, f1 found by one lane, f2 by two: max(D + f1·(k−1)/k, D + f1²/(2·f2)). Reading lanes
under-estimate when defects differ in difficulty: divide N̂ by κ (0.6 at k = 2, 0.8 at k = 4).

Another round on the densest chunks only on a same-population estimate: while found / N̂ < 0.7 and the
last round added more than 10% new findings. The estimate covers what READING can see; `live probe
needed` cells close only by a probe — true coverage has measured at half the estimate when most misses
were runtime-only. The report's `Coverage` line carries lanes, rounds, found and N̂; after the human
review lands, escapes go to the regression set ([eval.md](eval.md)), and an escape whose trigger has no
row in the TEST grid adds the row.
