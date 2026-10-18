# Lanes — several independent readers, one merged ledger

A single reader finds about half of what is there; two independent ones about three quarters. Reading
the same thing twice does not count: an identical rerun re-finds 85% of what the first run found. What
adds recall is a reader forced to BUILD something different — a label alone ("act as a tester") adds
nothing. So a lane is defined by the artifact it owns, and its findings are that artifact's gaps.

## Fleet, plan, rounds

`node <kit>/tools/review-plan.mjs plan --base <sha> [--paths <zones>] --out .agent/tmp/review-<slug>/plan --slug <slug> --scope "<MR !N …>" [--stand <url>] [--scratch <clone>]`
sizes the fleet: T0 none · ≤100 files → 2 lanes
(A = CONSUMER + SPEC, B = TEST + AUTHZ, B reading in reverse) · over 100 → 4 (A1 B1 over one zone
group, A2 B2 over the other). Every chunk is read by two lanes with different artifacts.

**No grant question** (review agents spawn unasked, per the kit delegation rule).
Before the first spawn, one line in the reply: the plan's `grant:` numbers, `lane-high` per
agent. Each spawn's `description` carries its tag — `deep-review r<k> lane <id>` for round k,
`deep-review verify <F-id>` for a cold verifier; `spawn-cost-guard` passes a tagged `lane-high` spawn
unasked, 40 per session, the 41st brings the dialog back. The plan's rounds are an estimate: while the
ledger has unread files, further rounds run unasked inside that cap — never re-tag a non-review spawn
to fit.

A lane stops at ~100 tool calls / ~12 minutes whatever its budget (!778: half of each zone unread,
nothing said). So the plan cuts each lane's chunks into rounds, and the loop is mechanical:

0. the scratch clone gets its dependencies BEFORE the first spawn — installed once, or `node_modules`
   junctioned from the main checkout when the lockfiles match; a lane never installs (a lane once lost
   a `sleep 60` and an install to a clone with none);
1. spawn every lane on its round-1 chunks (`deep-review r1 lane <id>`), the prompt verbatim from
   `plan/lane-<id>-r1.prompt.md` — `plan --slug` writes them; the template lives in the tool;
2. `review-plan check --plan <plan.json> <lane reports…>` — exit 1 prints `RERUN lane X: c012 c013…`;
3. a fresh agent per RERUN line as round k+1, same artifact, only those chunks, prompt from
   `review-plan prompt --plan <plan.json> --lane X --chunks c012,c013 --slug <slug> --scope "…"` — never
   a hint from a finding elsewhere (!778 round 2 carried truth hints: its score is void);
4. repeat until exit 0 or the granted rounds run out; its `**Ledger:** N/M files` line goes into the report verbatim.

**Long checks are the orchestrator's, and once.** A lane runs no `mustfail`: its reverts change files the
other lanes are reading in the same clone. After the lanes return, the orchestrator runs it once,
`--quick` first (one run says whether the change is covered at all), per-file only on a red quick —
in the background, no `| tail`, woken by the completion notice, never sleep-polled; one still running
after 30 min is stopped and reported as not finished. A measured review lost ~26 of a lane's 42 min to
mustfail (a 603 s foreground run hit the tool cap, then five sleep-polls).

**A message to a running lane names its outcome** — «hand back now» (write the ledger as it stands,
return) or «drop X, continue the rest». A bare «stop X» leaves the lane guessing which.

## The four artifact lanes

| lane     | owns this artifact                                                                                                                                                                                                          | reads first                                                                         | catches                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CONSUMER | changed symbol → every caller, sibling and parse site → the contract each relies on                                                                                                                                         | radius rows out-of-diff first                                                       | siblings deviating, parse twice, shared-code severity                     |
| SPEC     | frame line (ticket, epic child, spec, rule doc) and contract claim (schema, API docs, README, help — [axis-2.md](axis-2.md) §h) → code site → request on the stand → status                                                 | the contract and the frame, no hunk before them; then dependency order leaf → entry | docs ≠ code, unwalked acceptance lines, unapplied rule docs, «looks done» |
| TEST     | entry point × trigger grid (restart · recovery · workload / cap N and N+1 · config 0 / empty / unset · sequencing · compatibility · concurrency · twice · never · half-done) × exit × channel, one must-fail input per cell | tests first, then entry points                                                      | promise × exit × channel, config surface, tests that cannot go red        |
| AUTHZ    | role × action × layer (UI guard · route guard · API), plus each trust boundary's attacker                                                                                                                                   | route and permission maps                                                           | RBAC per flow, delegation, the attacker pass                              |

A cell is `clean — file:line` · `finding` · `n/a — why` · `live probe needed`; the lane is done when
no cell is empty. A lane that returns findings without its filled artifact is rerun. A contract cell
closes by a request only; with no stand it is `live probe needed`.

## Chunks and saturation

One pass reads at most ~400 changed lines (≈8k tokens of diff) plus the context it needs — recall
falls off sharply past that, and the file shown last is found least. The plan's chunks hold that size;
each chunk's candidates are written to the lane file before the next is opened. A pass that yields 5
or more candidates in one chunk is saturated: the chunk is halved and each half read again.

Read the diff **per file** (`git diff <base> <head> -- <file>`) or in 400-line windows (Read with `offset`/`limit`). A persisted `tool-results/*.txt` — a whole MR diff the MCP could not inline — is read to the last line — whole up to 96 KB, larger in the windows the read guard's refusal lists; a diff taken whole and skimmed by grep is not read, and its ledger rows are `skipped`.

## The lane prompt

`review-plan.mjs prompt` prints it filled — tags, deliverable path, resolved shas, chunk files, the
artifact cells of the table above, the sweep command, the ledger rule, the `<mr_text>` rule, the
scratch clone, the long-check and mid-run-message rules, the stand. A changed rule goes into the tool
(`ARTIFACT` and `promptFor`) and this table together; a prompt typed by hand drifts from both.

Each lane sees only its own inputs — never another lane's candidates — until the merge: independence
is what the stopping estimate below stands on.

## Merge

- **Union**, keyed by (mechanism, site). Agreement between lanes never raises a candidate and absence
  of agreement never kills one — only proof (SKILL §4) kills.
- **Cold verifier** for a 🔴/🟡 whose proof stops at L0: a fresh agent handed only the thesis and the
  evidence tries to refute it by the same ladder. Refuted → `✗` with the refutation; unresolved → ❓;
  contested → stays, marked contested. A finding proved by action stands on its output. The verifier
  also returns what the review missed — one pass over the diff with the classes.
- **Contract cells** left `live probe needed` are run by the orchestrator before the merge, against
  the stand on head ([live-proof.md](live-proof.md)); still no stand → "uncheckable". A verifier
  handed a contract finding re-sends the request — re-reading the doc refutes nothing.
- **Collapse check:** per lane, u = its unique verified findings / its verified findings. u < 0.2 → that
  lane read like another one; next run it gets a different artifact or order, never a plain rerun.

## Stopping estimate — a «keep going» signal, never «done»

`review-plan estimate --n1 <A> --n2 <B> --m <shared>` over verified, deduplicated findings of two
independent lanes (Chapman; m ≤ 2 → "coverage unknown, low"). k ≥ 3 lanes: D distinct, f1
found by one lane, f2 by two: max(D + f1·(k−1)/k, D + f1²/(2·f2)). Reading lanes under-estimate when
defects differ in difficulty: divide N̂ by κ (0.6 at k = 2, 0.8 at k = 4).

Another round of the pair on the densest chunks, inside the granted rounds, while found / N̂ < 0.7 and the last round added more
than 10% new findings. The estimate covers what READING can see; `live probe needed` cells close only
by a probe. !778: the estimate said 0.41, true coverage was 0.21 — most misses were runtime-only.

The report's `Coverage` line carries lanes, rounds, found and N̂. After the human review lands, the
escapes go to the regression set ([eval.md](eval.md)); an escape whose trigger has no row in the TEST
grid adds the row.
