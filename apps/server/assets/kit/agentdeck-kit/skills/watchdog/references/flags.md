# watchdog — reading a digest

## Shape

```
watch 21:40:02→21:44:47 4.8m wake=max · read 12kB · hi 0 mid 0
21:41:10 u1 DENY Bash git push … ← git-guard: … #u1:57
── every action (14) ──
21:41:02 u1 CALL Bash git status
…
[u1] SAFE ended 40s ago · ctx 96k · last 40s · conv 3f2a9c1d · <plugin parts>
[u2] busy(open Bash 3m pnpm test; bg 1) · ctx 140k · last 5s · conv 9b77e012
keepalive on · the turn ends on --stop "<owner's words>", hold.json, or every group done/failed
```

- Header: wall span, wake cause, bytes read, flag counts. Lines: `time unit TAG text #unit:n`.
- Flags first (time order), then EVERY routine action (`lo`: call with its command or path, hint, log line),
  one per line. Over `--budget` (8000 chars) only line WIDTH shrinks (mid 220→90, lo 140→50; hi up to 600 so
  a command in it stays copyable) — no line, flag or action is ever dropped or folded into a count.
- Every flag that is not `lo` carries `#u:n` — a ref into the state's ring (600 per unit); a flag with no
  transcript record (restart, window, gap) keeps its text in the ring, so the ref still reads.

## show.mjs — read by ref, never the whole transcript

`node $S/show.mjs --state <dir> …`
- `'#u:n' ['#u:m' …] [--max 3000]` — that record only (a text-only ref prints its kept text).
- `--list [unit] [--last 40]` refs · `--ctx [unit]` biggest context jumps and their cause · `--open [unit]`
  open calls, background tasks and async subagents per file.
- `--marks <unit>` — audit marks (`setup`, `stage:<s>`, `ended`, 30 kept). `--pack <unit> [--from <mark>]
  [--to <mark>] [--max 60000]` — one line per record between two marks (USER / TEXT / CALL / RES / ERR / SYS),
  every file of the unit; `--from` defaults to the last mark, `--to` to now. The input of a stage audit agent.

## Footer

`SAFE ended Ns ago` = turn ended + nothing open + no bg task + no running subagent. `busy(…)` names why:
`open <tool> <age> <cmd>`, `bg N`, `subs N`, `turn running`. `ctx` = input + cache read + cache creation of
the last assistant message (deduped by message id). `conv` = session id prefix — a change = new conversation.
A `log` unit or a unit with no transcript yet prints its reason only; a `log`/`dir`/`file` target that does not
exist prints `<kind> missing: <resolved path>` — a typo shows at setup, never as a quiet unit. Git Bash paths
(`/c/work/x`) are accepted in unit specs and path flags. The last footer line is the keepalive's state.

## hi — settle 8 s, then wake

| tag | means | first move |
|---|---|---|
| INJECT / NEWCONV | a prompt reached the unit (user, panel, hook) / a new conversation's first prompt | read it by ref when it steers the work |
| BRIEF | a prompt over 15k chars | read by ref; judge whether it needs that length |
| END | main turn ended — its last text | judge the claim against the ledger: done, proven, nothing parked |
| ASK | the agent asked a person (AskUserQuestion) | needless ask = S2 autonomy row |
| DENY | a tool call refused (hook guard, permission, user) | row the guard + reason; a wrong deny is a hook bug |
| ERR / TIMEOUT / INTR | a tool failed / timed out / was interrupted | real failure vs benign exit 1 (grep/diff are folded out) |
| HOOK | a hook blocked, exited non-zero, timed out, or Stop hooks errored | hook defect or the agent ignoring it |
| COMPACT | the unit compacted (`pre → post` tokens) | did it lose the plan? check the next turn |
| LIMIT / APIERR | LIMIT = status 429, limit words or `error: rate_limit`; any other API error (5xx, 529, ECONNRESET) = APIERR; first and last retry only | limit = wait; error loop = S1 |
| MODEL (hi) | refusal fallback to another model | row it; may change quality |
| RERUN | a check (test, lint, type-check, build, gate — any spelling) again with no Edit/Write since its run | same tree, same verdict: waste; the guard that let it through |
| CHECKER-LOOP | the same check or verdict (`tests-cli delivery/gaps/report/lint`) ×3 in one turn, edits between only to `.md`/`.txt`/`.agent/` | the group argues with the checker: read the checker's rule — its bug is the panel's row |
| BURN | one waste class (rerun, repeat, sleep, err-repeat) twice inside one turn | S1: the loop runs now — pause, fix, resume |
| STALL | no transcript growth for `--stall` (600 s) while busy, or a Bash past its own timeout | stuck = S1 |
| RESET / PARSE / UNKNOWN | file shrank / non-JSON line / new record type | parser drift: fix the watch itself |
| LOG! | an error-looking line in a `log:` unit («0 failed» / «0 errors» summaries excluded) | a proof went red or a service failed |

## mid — wake 60 s after the first, unless a hi comes

| tag | means | first move |
|---|---|---|
| WORD | «not verified», «for now», «pre-existing» … (English and Russian forms) in assistant text | parked work or an excuse: S2 until the line proves otherwise |
| SLEEP | a sleep / Start-Sleep / ping-wait in a command | blind waiting: the hook or the prompt that allowed it |
| REPEAT / REREAD | the same command again / a file re-read unchanged | wasted turn: cause, then the guard that should catch it |
| SLOW / OPEN / BGLONG | a call took ≥120 s / is still open past 120 s / a bg task or async subagent past 600 s | narrow it, background it, or accept with the reason |
| BIG / CTX+ / CTXHI | result ≥20k chars / one step added ≥20k context (not the first message after a compaction: baseline re-count) / context ≥180k | `show.mjs --ctx` names the cause |
| BG / BGDONE | background task started / ended (hi when killed, failed, timed out) | its result is read? |
| SPAWN / SUB | an agent spawned / a subagent started or finished | spawn allowed? its report read? |
| DIAG | IDE diagnostics reported errors | type error left behind |
| HINT / MODEL / INJECT (mid) | system warning / model switch / local slash command | row only when it changes the work |
| LOG | new lines in a `log:` unit (`lo` beyond the first few) | the feed or proof progressed |

Waste: REPEAT, RERUN, REREAD, SLEEP, SLOW, BGLONG, BIG, CTX+ and a repeated error carry a waste class — a
plugin may arm that unit's pause at its next safe point from it; STALL and BURN carry
it as a burn, which pauses NOW.

## Rows owed, keepalive

- Owed = every non-`lo` flag of the last digest except plain information (END, NEWCONV, SPAWN, SUB, BG, LOG,
  BACKLOG, HINT, RUN, STAGE, WINDOW, COVER, a quiet BGDONE) — and those too when they carry waste or burn.
  The next call exits 2 naming each owed ref with no row citing it in `--ledger-dir` (`*.md`; default
  `<P>/.agent/live-watch` when it exists). One row may cite several refs.
- Keepalive: a call with `CLAUDE_CODE_SESSION_ID` set, its state under `<P>/.agent/tmp/watchdog/` and at least
  one non-log unit registers the session: a kit copy in `<kit state>/watchers/<sid>.json` (`AGENTDECK_KIT_STATE`,
  else `<os temp>/agentdeck-kit-state`), a personal copy in `<config>/cache/watchers/<sid>.json`. The kit Stop item
  `watch-keepalive` then blocks the turn end with the exact next command — up to 3 blocks without a fresh
  call; an entry untouched 12 h is dead. Released only by: `--stop "<the user's words>"` (refused unless the
  words are in a message the user typed since the watch began), `<P>/.agent/live-watch/hold.json`, or every
  group done/failed (plugin). `--no-keepalive` = a helper call (parity agent, fixture) that must not register.

## Tunables (`core.mjs` `T`, CLI flags)

`--max 120 --settle 8 --batch 60 --poll 2 --budget 8000 --backlog 12 --stall 600 --from end|start`,
`--once` (one pass, no wait), `--config-root <dir>` (default `CLAUDE_CONFIG_DIR` or `~/.claude`),
`--ledger-dir <dir>`, `--stop "<words>"`, `--no-keepalive`. New units start at their end with a 512 KB tail
seeded (records older than 6 h are taken at the end unread); `--from start` reads from byte 0 — fixtures only.
Self-check after an edit to the scripts: `node <kit>/skills/watchdog/scripts/selftest.mjs` (prints its
pass count, exit 1 on any failure); the Stop item: the panel repo's `apps/server/src/domains/kit/watchdog-kit.test.ts`.
