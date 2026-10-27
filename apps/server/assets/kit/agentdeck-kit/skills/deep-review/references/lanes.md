# Lanes — several independent readers, one merged ledger

A single reader finds about half of what is there; two independent ones about three quarters. Reading
the same thing twice does not count: an identical rerun re-finds 85% of what the first run found. What
adds recall is a reader forced to BUILD something different — a label alone ("act as a tester") adds
nothing. So a lane is defined by the artifact it owns, and its findings are that artifact's gaps.

## Fleet, plan, rounds

`node <kit>/tools/review-plan.mjs plan --base <sha> [--paths <zones>] --out .agent/tmp/review-<slug>/plan --slug <slug> --scope "<MR !N …>" --scratch-root <scratchpad> [--tests-record <file>]… --risk <saved risk-tier output> [--stand <url>]`
clones head into `<scratchpad>/review-<slug>/clone` (= `$S/clone` of live-proof.md; without
`--scratch-root` under the OS temp dir), reuses it when it is already at head and refuses one at another
head, links `node_modules` where the lockfile matches and prints `install before the spawn:` for the
rest; every lane prompt names that clone. `--scratch <clone>` uses an existing clone at head,
`--scratch none` sizes only — no prompt can be made from that plan (a lane prompt once said
`<scratch clone>`: the lane ran no probe, two others built clones with `cp -r`). After the review:
`review-plan.mjs clean --scratch <clone>`, never `rm -rf` (its links point into the real checkout).
It sizes the fleet: T0 none · ≤100 files → 2 lanes
(A = CONSUMER + SPEC, B = TEST + AUTHZ, B reading in reverse) · over 100 → 4 (A1 B1 over one zone
group, A2 B2 over the other). Every chunk is read by two lanes with different artifacts.

Sizing is by estimated diff tokens, `(bytes + 8·lines)/2.2`: a chunk closes at ~400 changed lines or
≈17.7k tokens (half a round, so two always fit one), a lane-round at 5 chunks or ≈35k = 60k cap − 9.5k brief − 15k working room (`--chunk-tokens` / `--round-tokens`) — a 5-chunk round
of prose diff ≈ 95k once compacted a lane mid-review. A data file (a `*baseline*` / lockfile, a JSON
record array) is one `data` chunk owned by one lane, its key-level added/removed/changed summary in
that lane's prompt and whole in `plan/data-<id>.txt` (one baseline JSON was 65% of the changed lines,
and both lanes re-derived the same set diff). `--risk` stores the tier; every `--tests-record` is named
as the clean-head baseline lanes never re-run.

**Continuation** (new session, pause, compaction): `review-plan.mjs status --plan <plan.json>` first —
stored tier, lanes, rounds run (reports found in `.agent/tmp/review-<slug>/`), the next command, instead
of re-running risk-tier and re-reading this file.

**No grant question** (review agents spawn unasked, per the kit delegation rule).
Before the first spawn, one line in the reply: the plan's `grant:` numbers, `lane-high` per
agent. Each spawn's `description` carries its tag — `deep-review r<k> lane <id>` for round k,
`deep-review verify <F-id>` for a cold verifier; `spawn-cost-guard` passes a tagged `lane-high` spawn
unasked, 40 per session, the 41st brings the dialog back. The plan's rounds are an estimate: while the
ledger has unread files, further rounds run unasked inside that cap — never re-tag a non-review spawn
to fit.

A lane stops at ~100 tool calls / ~12 minutes whatever its budget (!778: half of each zone unread,
nothing said). So the plan cuts each lane's chunks into rounds, and the loop is mechanical:

0. the scratch clone gets its dependencies BEFORE the first spawn — whatever `plan` printed under
   `install before the spawn:` is installed there once (the rest it already linked); a lane never
   installs (a lane once lost a `sleep 60` and an install to a clone with none);
1. spawn every lane on its round-1 chunks (`deep-review r1 lane <id>`); `plan --slug` writes
   `plan/lane-<id>-r1.prompt.md` (the template lives in the tool, ≤ 20 KB; `PROMPT OVER CAP` → split the
   round with `--chunks`). The spawn prompt is the stub `plan` prints — `Your full brief is <abs path> —
Read it first, in one Read.` + the `[return-format]` and `[no-subagents]` literals: one Read for the
   lane. Verbatim stays allowed, at the whole prompt in output tokens per spawn (45 spawns × ~8k ≈ 350k);
2. `review-plan check --plan <plan.json> <lane reports…>` — exit 1 prints `RERUN lane X: c012 c013… — why`
   for files without a ledger row AND for every planned round no report header `# Lane X rK — c…`
   proves ran (planned rounds were once reported as run while one of two ran);
3. a fresh agent per RERUN line as round k+1, same artifact, only those chunks, prompt from
   `review-plan prompt --plan <plan.json> --lane X --chunks c012,c013 --slug <slug> --scope "…"` — never
   a hint from a finding elsewhere (!778 round 2 carried truth hints: its score is void);
4. repeat until exit 0 or the granted rounds run out; its `**Ledger:** N/M files · … rounds k of N` line
   goes into the report verbatim;
5. when the review is done (the last verifier and probe returned), `review-plan.mjs clean --scratch <clone>`
   — the line `plan` printed after `remove after the review:`.

**Long checks are the orchestrator's, and once.** A lane runs no `mustfail`: its reverts change files the
other lanes are reading in the same clone. After the lanes return, the orchestrator runs it once,
`--quick` first (one run says whether the change is covered at all), per-file only on a red quick —
in the background, no `| tail`, woken by the completion notice, never sleep-polled; one still running
after 30 min is stopped and reported as not finished. A measured review lost ~26 of a lane's 42 min to
mustfail (a 603 s foreground run hit the tool cap, then five sleep-polls).

**A message to a running lane names its outcome** — «hand back now» (write the ledger as it stands,
return) or «drop X, continue the rest». A bare «stop X» leaves the lane guessing which.

**The orchestrator merges, never reads.** It reads no chunk itself; a live probe or a dev server is a
lane of its own (`deep-review r<k> probe <cell>`). Each hand-back is appended to
`review-<slug>/findings.md` with one Edit at its end — never a rewrite, never a re-read of the file (a
measured review rewrote it per hand-back plus its own probes: 71k → 218k context, two compactions).
**Base comparison needs no second tree.** «Was this check red on base too?» = its error lines against
`git show <base>:<file>` per named file — no node_modules junction, no D-n deferral (a measured review
spent two human decisions on a base tree that could not run). A `git archive` clone of base is the last
resort: only when the check must RUN on base and no file comparison answers.

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

**Test bodies are TEST's alone.** `plan` puts test files in chunks of their own, routed to TEST lanes
only; a CONSUMER + SPEC lane never reads a test file. With `--parity <check>` (a content parity check)
a translation whose source-locale twin is in the diff is TEST-only too, row `swept — parity <check>`
(a measured 705-file review: 144 test files and 56 translations read twice; 42 → 32 lane-rounds). A
lane hands back at ≈60k context — its prompt prints the cap; unread chunks become RERUN rounds.

## Chunks and saturation

One pass reads at most ~400 changed lines plus the context it needs — recall falls off sharply past
that, and the file shown last is found least. Lines are the recall bound, tokens the context bound:
400 lines of code ≈ 8k tokens, 400 lines of prose or JSON with context up to ~50k. The plan's chunks hold both;
each chunk's candidates are written to the lane file before the next is opened. A pass that yields 5
or more candidates in one chunk is saturated: the chunk is halved and each half read again.

Read the diff **per file** (`git diff <base> <head> -- <file>`) or in 400-line windows (Read with `offset`/`limit`). A persisted `tool-results/*.txt` — a whole MR diff the MCP could not inline — is read to the last line — whole up to 96 KB, larger in the windows the read guard's refusal lists; a diff taken whole and skimmed by grep is not read, and its ledger rows are `skipped`.

## The lane prompt

`review-plan.mjs prompt` prints it filled — tags, deliverable path and its round header (one Write,
then Edit; never echo or a heredoc — a refused heredoc once had the block written 3×), resolved shas,
chunk files, data-chunk summaries, the artifact cells of the table above, the sweep command, the ledger
rule, the `<mr_text>` rule, the recorded runs as the clean-head baseline, the scratch clone, the
long-check and mid-run-message rules, the stand. A changed rule goes into the tool
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

`review-plan estimate --n1 <A> --n2 <B> --m <shared> --plan plan.json --pair X,Y` over verified,
deduplicated findings of two lanes reading ONE population — same artifacts, same chunks; the tool checks.
The plan's A × B never do (A skips tests, artifacts differ): m is small by construction, N̂ inflated, the
line says ADVISORY ONLY and drives no round (a measured review: «remaining ≈87» bought extra rounds) (Chapman; m ≤ 2 → "coverage unknown, low"). k ≥ 3 lanes: D distinct, f1
found by one lane, f2 by two: max(D + f1·(k−1)/k, D + f1²/(2·f2)). Reading lanes under-estimate when
defects differ in difficulty: divide N̂ by κ (0.6 at k = 2, 0.8 at k = 4).

Another round on the densest chunks, inside the granted rounds, only on a same-population estimate: while found / N̂ < 0.7 and the last round added more
than 10% new findings. The estimate covers what READING can see; `live probe needed` cells close only
by a probe. !778: the estimate said 0.41, true coverage was 0.21 — most misses were runtime-only.

The report's `Coverage` line carries lanes, rounds, found and N̂. After the human review lands, the
escapes go to the regression set ([eval.md](eval.md)); an escape whose trigger has no row in the TEST
grid adds the row.
