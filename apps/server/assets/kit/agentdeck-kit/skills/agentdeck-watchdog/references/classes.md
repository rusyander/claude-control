# agentdeck-watchdog — group flags and seed classes

## Group flags (on top of watchdog's, references/flags.md there)

| tag | sev | means |
|---|---|---|
| STATUS | mid; hi on `paused`/`held`/`failed` or a human wait | `status(waitingFor)` changed in `state.json` |
| ENDED | hi | group `done`/`failed`, with its MR and the audit line of the last stage + whole run |
| STAGE | hi | stage advanced (`triage → plan → work → review → fix → deliver`, contracts `CASCADE_STAGES`): duration, tokens, audit agent to spawn (references/loop.md §Stage audit) |
| NUDGE | mid; hi + waste from #2 | panel nudged delivery again — 2+ = group cannot finish alone |
| ROUND / MISSING | mid; ROUND hi + waste from 2 | delivery round N; each newly missing item (first 3 shown) |
| MR | hi | MR link set or changed |
| CONV | mid | group's chat id changed (cold continuation = new conversation) |
| WSIG | hi; mid for `info` | panel watcher signal: rule id (R1…R46), severity, stage, rule text from `apps/web/src/shared/config/i18n/group-watch/en.ts` (a variant's own text: R38done, R16slow…). Our finding of the same rule, group and call (RERUN R4, WINDOW R9, SLOW R16, BRIEF R37, RESTART R38, STORM R39, LEDGER R40, GAP R41, RUN R42; waste or hi only) rides on it as `· +TAG: …` and owes no row of its own; its waste arms as `WSIG <rule>` with the WSIG ref (lib/fold.mjs). No WSIG that call → our flag stands |
| RESTART | hi + waste when a group's own Edit/Write (≤10 min before) changed the file; hi on a pending restart a watched copy's run holds, `dev-restart.request`, `упал`/`exited`/`error`; else mid | one line per cause per pass: file + `edited by gN` / `edited by no watched group`, or `requested` |
| NEXT | hi, once per group (no row owed) | group of a watched split, unclosed and unwatched, got its copy; next call adds it, keepalive holds while one is open |
| IDLE | hi, once per ended turn | turn ended past `--stall` (600 s), nothing open, not closed, no person/limit wait (`paused`/`held`/`pending`/`waiting` skipped) — conveyor never started the next turn; STALL needs a running turn |
| STORM | hi, once per 30 min | 3+ server restarts within the last hour in `dev-watch.log` |
| LEDGER | hi: green re-run on a key the legend holds (waste), legend off for the copy, replay would differ, mode off/shadow; mid: replay refused (stale/output/artifact), not recorded (tree moved mid-run), 3+ real runs with 0 replays in one call (waste) | feed `<app-data>/verify-ledger/events.jsonl`, events whose `repo` is in a watched copy |
| GAP | hi + waste | a check the ledger preload sees (vitest, tsc, eslint, prettier, vite build, `pnpm test/lint/type-check/build`) ran with no ledger event from its copy in [start−3 s, end+10 s] — outside the legend, never replayable; judged 20 s after end. A check = a standalone word in a quote-aware `&&`/`;`/`|` segment whose head is no reader (`grep`, `cat`, `tail`, `node -e`…): a file name (`vitest.config.ts`), a quoted string or a grep pattern is not a check |
| RUN | mid; hi + waste when heavy | finished panel run (`<app-data>/limit-runs.json`): tokens, time, 5h/7d window and its move; heavy = +5 % 5h, +2 % 7d or 3M tokens |
| WINDOW | hi, once per level per reset | 5-hour or 7-day window crossed 80/90/95 % — arms every group's pause |
| DEFER | hi, once per D-n | call of the group parked for the human (`<app-data>/deferred-asks.json`, state waiting); group works on, status never shows it |
| PAUSED / PAUSE! | hi | armed pause fired: HTTP 2xx / refused (body quoted, token redacted), naming the arming flag; PAUSED adds `resume: coordinator … due HH:MM — <resume command>` |
| UNRESUMED | hi, once per pause | a pause this watch made still stands past its due time (15 min), no `hold.json` — fix the row and resume; also printed inside an owed-rows refusal |
| WATCH-DARK | hi, once per call | no watch pass for > 15 min while a group this watch paused stood; also inside an owed-rows refusal |
| PAUSE-STALE | mid | a burn arm seen > 30 s late whose own call already returned — downgraded to the safe point instead of cutting the running call |
| PAUSE-RACE | hi | 2xx pause that did not hold after 20 s (transcript still grows, or status still pausable) |
| COVER | hi, once per change | a source the watch depends on went unread (state, rule texts, legend feed, dev-watch log, limit window) |

Footer extras: `<status>(<waitingFor>) · stage · nudges · missing · mr · dirty N|clean` (git
`--no-optional-locks`: no index lock), `not pausable in <status>` when SAFE but status refuses a pause,
`ARMED pause at safe point|NOW (<flag> #ref)`, group's window share, `legend rec N (time) hit M (saved, %) Δ K · top miss reasons`;
core adds `spent N msg out/write/read`. Last digest line: `COVER state · rule texts · legend k/n copies · restarts N/h · window 5h a% 7d b% · transcripts · spend` — ✓ or ✗ per source.

## Seed classes (24.10 watch, inbox I-01…I-15)

| class | shows as | layer | the class fix, not the instance |
|---|---|---|---|
| `boot-strip-types` | RESTART `упал`, boot probe error | panel server | TS syntax outside strip-types (param properties, enums): every server module imports under `--experimental-strip-types` |
| `git-target-misparse` | DENY on a legit git command with `$(…)` | panel server (broker) | resolve command substitution before judging the target |
| `shell-alias-unasked` | shell-snapshot alias/function runs past the broker | panel server | snapshot names route to the broker in every CLI's auto mode |
| `windows-shell-gap` | irreversible PowerShell step ran unasked (S1) | panel server, auto-approve | every Bash ask/deny rule has its PowerShell/cmd twin, single chat and group alike |
| `user-wrapper-to-human` | `cd`/`git` wrapper → always the human | — | wontfix: unknown wrapper = unknown effect, fail-closed |
| `self-mod-refused` | auto mode refuses a `<config>/settings.json` edit | global | user-run script in `.agent/tmp/`, never a workaround |
| `ts-red-tests` | DIAG / type-check red in a test file | product tests | fix types at the gate's first sight |
| `stale-check` | check red because the environment moved (CLI version) | the check | pin the env the check needs, never skip it |
| `flaky-under-load` | timeout only in parallel runs | the test | own budget or serial lane; green alone is no proof |
| `sieve-false-gap` | sieve reports a missing run that is recorded | tests block | accept every id form the history stores |
| `resume-drops-gaps` | NUDGE/ROUND after resume, false «stalled» | split conveyor | delivery gaps survive pause, limit, interrupt |
| `cold-brief-bloat` | BRIEF on every CONV | cold continuation | brief carries state, never the replayed command list |
| `suite-too-wide` | SLOW/TIMEOUT on a package-root case | tests block | a case runs its own files, not the package |
| `legend-rerun-unchanged` | LEDGER hi, legend hit % low, same check twice on one tree | verify-ledger | unchanged area replays; only the changed area runs (file-list vitest included) |
| `restart-storm` | STORM, many RESTART lines | dev-watch | restart after a quiet window, never per save |
| `watch-blind-source` | COVER ✗, a footer part missing | watch scripts | every source the watch depends on is named in COVER and selftested |
| `owner-term-unknown` | answer about the wrong thing | coordinator | look the term up in memory + transcripts, save at once |
| `rerun-same-tree` | RERUN, BURN rerun | the guard the group passed (verify-throttle, gate-at-end) or the prompt that asked twice | a check reruns only after an edit; the guard knows every spelling |
| `legend-gap` | GAP | provider env / run registry | ledger's `NODE_OPTIONS` preload reaches every CLI's shell |
| `restart-by-group` | RESTART `edited by gN` | dev-watch / the group's edit zone | a group's save into the served tree never restarts the panel mid-run |
| `pause-race` | PAUSE-RACE | panel server (pause path) | a 2xx pause stops the turn and holds |
| `window-burn` | RUN heavy, WINDOW | the group's spend (model tier, wide reads, reruns) | cheapest model and narrowest check for the step |
| `judge-to-human` | DEFER | group judge (`group-command/**`, `group-permissions.ts`) | only deletion, merge, push to a protected branch, super-critical steps reach the human; reproduce with `groupDecision`, fix the rule, restart — `rejudge.ts` clears the waiting D-n |
| `conveyor-idle` | IDLE | split conveyor (panel server) | every non-human wait starts the next turn or has a status naming what it waits on |
| `stage-audit-finding` | stage-audit finding the digest never flagged | watch scripts | the flag that should have caught it, selftested |

Standing classes (protocol + CLAUDE.md): needless human ping (ASK, human-wait STATUS) · sleep-polling
(SLEEP) · re-reads (REREAD) · gate mid-task or CI wait (DENY by `gate-at-end` / `pipeline-watch-guard`)
· parked work (WORD) · help or changelog missing at delivery (MISSING) · delivery loop (NUDGE 2+).
A new class gets a slug in the ledger and joins this set at watch end.
