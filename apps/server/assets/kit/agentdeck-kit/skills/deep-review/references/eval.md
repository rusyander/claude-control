# Eval — a skill edit is measured, not argued

Two yardsticks, both under the project's `.agent/evals/deep-review/<case>/` (never committed),
`history.jsonl` one scored row per run. **Seeded bench** — defects planted in a real MR: cheap, exact
truth, measures recall, site precision, tokens and wall time; run on every edit to this skill or its
tools. **Human-truth cases** — real MRs whose other reviewers' findings are frozen: measures what
reviewers actually catch; run before a change to the hunt itself ships. No reviewer names anywhere in
a case.

## Seeded bench — `review-bench.mjs`

1. `seed --repo <dir> --base <sha> --head <sha> --case <slug> --parent twin [--n 12]` plants N small,
   compiling defects on ADDED lines (a seed the build or type-check flags measures nothing) as a commit
   made through git plumbing, kept under `refs/bench/<slug>`; `--parent twin` gives it head's own
   parents, so `base..seededHead` reads like the original MR. The truth lives in the case dir only —
   never in the repo, a commit message, a path or a prompt (case and run dirs carry neutral names).
2. `prompts --case <slug> --label <name> --tools <dir> --scratch-root <dir>` writes every lane-round
   brief for that range against the tools in `--tools` — a frozen snapshot of `<kit>/tools` for the
   baseline, `<kit>/tools` itself for the candidate. Spawn the stubs as in [lanes.md](lanes.md), then
   merge, prove and assemble as SKILL §5–7.
3. `score --case <slug> --label <name> --session-dir <project>/<session>/subagents --write` matches
   candidate lines to the truth (file suffix, ±3 lines) and sums cost from the subagent transcripts:
   located recall, candidates, spawns, tokens, turns, calls per turn, peak context, wall per wave.

Gate: located recall does not fall, and tokens or wall time fall without it. One run per side is a
signal, not a verdict: a gain inside one seed is reported as no change.

## Human-truth cases — `review-eval.mjs`

Case = `case.json` (repo, base, head, zones), `gt.md` rows `- A1 [block] <where> — <what>`,
`candidates.md` (harvested, not yet truth). `node <kit>/tools/review-eval.mjs list` shows each case
and its last score.

Feeding — after every human review lands:

1. `review-sync --write` on our report fills "Found by others"; each row gets its class or "not a
   miss: …". `review-sync --all` prints the calibration over every report: published · accepted ·
   addressed by a commit · declined · silent, precision = (accepted + addressed) / published.
2. `review-eval harvest <report> --case <slug> --write` appends the rows not classified as noise to
   `candidates.md` (names stripped, deduplicated by note).
3. Triage: a candidate that holds at the reviewed head becomes a `gt.md` row; `[block]` when a reviewer
   held the MR for it. A reviewed MR with ≥10 colleague findings and no case yet gets one — never an MR
   picked because the skill missed things on it (that measures one run's blind spots, not hardness).
4. From 4 cases on, about a third carry `"heldout": true`: `score` prints counts only, and while a
   skill edit is in progress nobody opens their `gt.md` or judge files.

Running — started by the user (it spends lanes), never implied by the edit itself:

1. `review-eval prompt <case> --dir .agent/tmp/eval-<case>-<date>` — clones at head, plans, writes one
   blind brief per lane (the truth never enters a prompt).
2. Lanes and `review-plan check` rounds exactly as in [lanes.md](lanes.md).
3. `review-eval judge-prompt <case> --reports <lane files>` → two fresh judge agents (never a lane,
   never the run's own author), each writing its own `judge-N.json`.
4. `review-eval score <case> --judge judge-1.json,judge-2.json --label "<what changed>" --dir <run dir>`
   — an item matches only when both judges match it; prints recall, blocking recall, the delta and the
   gate against the last clean row. A run outside this protocol (truth hints in a prompt, self-judged,
   no lanes) gets `--void "<why>"`.

Gate: blocking recall does not fall, and recall does not fall by more than one item. A fall names the
edit that caused it; the edit is reworked or dropped, never shipped on argument. A gain is real only
past the noise: the base skill needs ≥2 clean runs, and a gain within its spread is no change. A void
row is never a baseline.

## Overfit guard — the skill never learns the answers

`score` scans SKILL.md + references for the case's truth: a location or ticket id voids the row; a
code identifier is a warning — keep the rule only if it reads as general reviewing knowledge without
the case, otherwise reword it generally or drop it. A miss is fixed by the class of defect behind it,
never by naming the instance; a case's own incidents stay out of these docs.
