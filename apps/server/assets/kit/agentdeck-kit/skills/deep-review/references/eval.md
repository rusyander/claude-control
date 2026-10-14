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
   held the MR for it. A reviewed MR with ≥10 colleague findings and no case yet gets one — never an
   MR picked because the skill missed things on it (that measures one run's blind spots, not hardness).
4. From 4 cases on, about a third carry `"heldout": true` in `case.json`: `score` prints counts only,
   and while a skill edit is in progress nobody opens their `gt.md` or judge files. Edits are designed
   from the other cases' misses; train up with held-out flat = the edit fits the cases, not reviewing.

## Running it — before an edit to SKILL.md or a reference ships

Started by the user (it spends lanes), never implied by the edit itself.

1. `review-eval prompt <case> --dir .agent/tmp/eval-<case>-<date>` — clones at head, plans, writes one
   blind prompt per plan lane (spawn tokens included; the truth never enters a prompt).
2. One agent per prompt, then `review-plan check` rounds exactly as in [lanes.md](lanes.md).
3. `review-eval judge-prompt <case> --reports <lane files>` → two fresh judge agents (never a lane,
   never the run's own author) on the same prompt, each writing its own `judge-N.json`.
4. `review-eval score <case> --judge judge-1.json,judge-2.json --label "<what changed>" --dir <run dir>`
   — an item is matched only when both judges match it (a split counts as partial and is listed);
   prints recall, blocking recall, the delta and the gate against the last clean row; records lanes.
   A run outside this protocol (truth hints in a prompt, self-judged, no lanes) gets `--void "<why>"`.

Gate (printed by `score`): blocking recall does not fall, and recall does not fall by more than one
item. A fall names the edit that caused it; the edit is reworked or dropped, never shipped on argument.
A gain is real only past the noise: the base skill needs ≥2 clean runs (rerun it unchanged first), and
a gain within its spread is reported as no change. A void row is never a baseline.

Overfit guard — the skill never learns the answers. `score` scans SKILL.md + references for the
case's truth: a location or ticket id voids the row; a code identifier is a warning — keep the rule
only if it reads as general reviewing knowledge without the case, otherwise reword it generally or
drop it. A miss is fixed by the class of defect behind it, never by naming the instance.
