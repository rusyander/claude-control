# Eval — a skill edit is measured, not argued

The regression set is real MRs whose other reviewers' findings are frozen as ground truth:
`.agent/evals/deep-review/<case>/` of the project (never committed) — `case.json` (repo, base, head, zones), `gt.md` rows
`- A1 [block] <where> — <what>`, `history.jsonl` (one scored row per run, keyed by the skill's
fingerprint), `candidates.md` (harvested, not yet truth). No reviewer names anywhere in a case.
`node <kit>/tools/review-eval.mjs list` shows each case and its last score.

## Feeding it — after every human review lands

1. `review-sync --write` on our report fills "Found by others"; each row gets its class or "not a miss: …".
2. `review-eval harvest <report> --case <slug> --write` appends the unclassified-as-noise rows to
   `candidates.md` (reviewer names stripped, deduplicated by note).
3. Triage: a candidate that holds at the reviewed head becomes a `gt.md` row; `[block]` when a reviewer
   held the MR for it. A reviewed MR with ≥10 colleague findings and no case yet gets one.

## Running it — before an edit to SKILL.md or a reference ships

Started by the user (it spends lanes), never implied by the edit itself.

1. `review-eval prompt <case> --dir .agent/tmp/eval-<case>-<date>` — clones at head, plans, writes one
   blind prompt per plan lane (spawn tokens included; the truth never enters a prompt).
2. One agent per prompt, then `review-plan check` rounds exactly as in [lanes.md](lanes.md).
3. `review-eval judge-prompt <case> --reports <lane files>` → a fresh judge agent (never a lane)
   writes `judge.json`: matched / partial / beyond.
4. `review-eval score <case> --judge judge.json --label "<what changed>"` — prints recall, blocking
   recall and the delta against the previous row.

Gate: blocking recall does not fall, and recall does not fall by more than one item. A fall names the
edit that caused it; the edit is reworked or dropped, never shipped on argument. A run whose prompts
carried anything from `gt.md` is void — the label says so and the row is not a baseline.
