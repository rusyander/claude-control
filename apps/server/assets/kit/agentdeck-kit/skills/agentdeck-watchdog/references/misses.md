# agentdeck-watchdog — misses ledger

What the watch let slip, why invisible, the guard now. Read at every preflight and after compaction. A slip
matching a row = the guard failed: reopen the guard, not the instance. New slip → new row in the same pass as its fix.

| id | date | slipped | why invisible | guard now |
|---|---|---|---|---|
| M-01 | 24.10 | turn ended on a background notifier, watch dormant for hours | nothing outside my turn keeps the loop alive | §0 loop contract; blocking foreground waits only; session brief `WATCH ACTIVE` while a watch state woke within 24 h; Stop hook `watch-keepalive` (25.10) blocks turn end with the next command until the user's quoted `--stop`, `hold.json` or all done; Red flag |
| M-02 | 24.10 | group #1 done, next not started until asked | «group done» read as «task done» | §0 step 5; `NEXT` per unwatched open group of a watched split; keepalive holds while one is open, next command carries `--group` (25.10) |
| M-03 | 25.10 | «legend» taken for WSIG rule texts | defined earlier, not in memory | a memory note with the definition; unknown user term → `grep -l <term> <config>/projects/<proj>/*.jsonl` + memory before answering, save the definition; Red flag |
| M-04 | 24–25.10 | legend replayed 11 % of runs; file-list vitest re-ran after unrelated edits | ledger feed no watch source | `LEDGER` flags + footer `legend rec/hit/Δ` per copy + `COVER legend` (watch-groups.mjs `scanLedger`) |
| M-05 | 23–24.10 | dev-watch restarted the server 1332 + 362 times (per save, 300 ms debounce) | each one mid `RESTART` line | `STORM` hi at 3+/h (M-19), one restart line per cause per pass, `COVER restarts N/h` |
| M-06 | 24.10 | group token/time spend unseen | no spend number in digests | footer `spent N msg out/write/read` per unit (core `Watcher.spent`); `RUN` per run; every waste flag owes a row (M-23) |
| M-07 | 24.10 | second parity agent for finished work | running agents unchecked | before any spawn: ListAgents + `.agent/tmp/` deliverables for the zone |
| M-08 | 25.10 | the user asked three times; tool work went on | questions read as context | §0: a mid-turn user question gets the very next text |
| M-09 | 24.10 | stale seed → false STALL, stale open call held `busy`, last-unit drop lost | selftest lacked old-file and empty-unit cases | core `seed()` + `run.mjs` fixed; selftest cases; mutants killed |
| M-10 | 25.10 | skill not reloaded after compaction | summary carried the task, not the procedure | session-brief `WATCH ACTIVE` line names the skill and this file |
| M-11 | 25.10 | «works» from code reading, not the live feed | claim with no number passed | Red flag: every claim to the user carries a number from the live source it names |
| M-12 | 25.10 | group #3 resumed mid-fix (I-31, legend) | resume was a bare HTTP call | `group-control.mjs resume` refuses, no request, while `.agent/live-watch/hold.json` exists or the inbox has an `open`/`fixing` row not named in `--allow-open`; user pause = `hold --reason`, user start = `release --owner` |
| M-13 | 25.10 | boot installed the half-edited verify-ledger into live groups | `verify-ledger/bin/current` no watch source | panel: boot installs HEAD while `tools/verify-ledger` is dirty (I-32); watch: `LEDGER` mid `legend reinstalled A → B` between wakes |
| M-14 | 24–25.10 | REPEAT I-14: cold «Continue» brief 39k chars | fix at one entry; sibling fed the same sink | §4: fix at the enforcer every entry shares, grep each entry feeding the sink, one test per entry |
| M-15 | 24–25.10 | digest folded calls into «Bash 14, Read 9», dropped mid flags over budget | built for cheap wakes | core.mjs digest: every call with command/path one per line, budget only narrows, never drops; `--max` 120; selftest «every action listed», «no action collapsed or dropped», «tight budget keeps every hi and mid flag» |
| M-16 | 25.10 | flags passed with no row; next wake buried them | row was an unchecked habit | every non-lo flag carries `#u:n`; next call exits 2 naming each owed ref no `live-watch/*.md` row cites; session brief names owed rows |
| M-17 | 25.10 | waste flag seen, group kept running and repeated it | pause needed a coordinator order | waste arms the group's safe-point pause, BURN / STALL pause NOW, WINDOW arms all; `--disarm` only with a fixed row |
| M-18 | 25.10 | checks ran outside the legend (no preload in a CLI's env) | ledger feed shows only what reached it | `GAP` hi: a legend check with no ledger event from its copy while it ran |
| M-19 | 23–25.10 | restarts counted, never attributed | dev-watch logs the file, not its editor | `RESTART` per cause, `edited by gN` from the group's Edit/Write (hi, arms gN); STORM at 3+/h |
| M-20 | 25.10 | stage waste visible only as totals | no per-stage input small enough to read | STAGE / ENDED carry duration, tokens, an audit spawn over `show.mjs --pack` between stage marks |
| M-21 | 25.10 | groups burned the 7-day window to 97 % unseen | `limit-runs.json` no watch source | `RUN` per finished run with window move, `WINDOW` at 80/90/95 % arms every group, COVER `window` |
| M-22 | 25.10 | pause answered 2xx, group kept writing | 2xx taken for the fact | `PAUSE-RACE` 20 s after the pause; one pause per chat + stage |
| M-23 | 25.10 | waste passed under bands (legend hits <30 % over 5 runs, restarts 6+/h, NUDGE 2 mid) | bands defined «normal» waste | bands removed: every waste flag owes a row and arms a pause; NUDGE/ROUND #2+ hi |
| M-24 | 25.10 | every api_error (502, 529, ECONNRESET) tagged LIMIT → pause on an outage | LIMIT read from key names; real records carry `rateLimits: null` | LIMIT only from status 429 / limit text / `error:'rate_limit'`; show.mjs passes the ledger keys to a foreign whole-document ref |
| M-25 | 25.10 | group SAFE for hours while panel showed running | STALL needs a running turn; stopped conveyor writes no record | `IDLE` hi: turn ended past `--stall`, nothing open, status neither closed nor a human/limit wait |
| M-27 | 25.10 | dev-watch booted the panel onto a mustfail mutant (conflicts.ts) and its restore | `RESTART` named the file, not the mustfail holding it | dev-watch defers while a live mustfail journal holds a served file, drops a restart for a file back at its original (I-46, token-economy-381) |
| M-28 | 25.10 | D-3 (g3: go test in a docker container named by `$CID`) waited 20 min | a D-n leaves group status alone; watch read only status | `DEFER` hi per waiting D-n of a watched group, `D-n` part in COVER; judge fix + `rejudge.ts` on restart |
| M-29 | 25.10 | false BURN paused g3 (`docker create … sleep 600`); LEDGER hi on first records | SLEEP read from any word in the command; first record counted as missed replay | `sleepWaits` by segment head (container payload skipped); legend fresh key (no-record, never seen) not counted; selftests for both |
| M-30 | 25.10 | g3 ENDED audit pack held 0 records («from ended to ended») | `show.mjs` fell back to the last mark when the named `--from` was never recorded | named missing mark → from the start, header names it; selftest-groups «unrecorded mark» |
| M-32 | 27.10 | watcher's mustfail (5 vitest runs) overlapped g9's full gate; g9 red twice on load-timeout flakes and reran the whole gate; a 10-min gate chain read as `grep` | watch-side checks ran outside the heavy queue; brief cut a chain at its head; project `scripts/check_*` no check | §3a: no watch mustfail / multi-file vitest while `node <R>/tools/heavy-queue-hook.mjs status <queue dir>` shows a group gate; core.mjs brief names `[runs <checks>]` first, CHECK_RE has project gate scripts (selftests + 2 mutants) |
| M-26 | 25.10 | 41st stage audit of a session would stop the watch on a spawn ask | cap lived in the hook, watch never read it | audit line ends with budget left; past the cap with no grant the coordinator audits from the pack |
| M-31 | 26.10 | g1 paused 74 min (due +58 min), no UNRESUMED; late BURN cut an unrelated call | owed-rows refusal ran no pass; a `now` arm never checked its call had returned | refusal prints UNRESUMED / WATCH-DARK (status only); WATCH-DARK in the pass; burn > 30 s late on a returned call → PAUSE-STALE, safe point; selftest-stage-audit G/H |

Proof: `scripts/selftest-groups.mjs`, `scripts/selftest-stage-audit.mjs`, `watchdog/scripts/selftest.mjs`,
`watchdog/scripts/selftest-foreign.mjs` (each prints its pass count, exit 1 on any failure) and the Stop item
`watch-keepalive` in the panel repo's kit tests.
