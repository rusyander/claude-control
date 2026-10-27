---
name: agentdeck-watchdog
description: "Use when watching AgentDeck split groups live — pause at a safe point, fix, resume: "watch the group", "be the watcher"; base loop → watchdog."
---

# agentdeck-watchdog — split groups under live watch

Runs the `watchdog` loop over AgentDeck split groups. Read `<kit>/skills/watchdog/SKILL.md` first: its
steps, Red flags and references all apply; this skill adds the panel's state, the watch protocol and the
levers that pause a group without losing its work.

`G=<kit>/skills/agentdeck-watchdog/scripts` (`watch-groups.mjs`, `group-control.mjs`,
`selftest-groups.mjs`). `R` = the agentdeck repo; state dir `R/.agent/tmp/watchdog/<slug>`. Group flags,
footer and the seed classes → [references/classes.md](references/classes.md). Auto pauses, stage audits,
restart, kit, parity targets, foreign groups → [references/loop.md](references/loop.md).

## 0. Loop contract — never skipped, survives every compaction

Left as the watcher, I run this until the user stops it or no group is left:
1. Watch the group with no gap — EVERY action of the group read, not only flagged ones: the digest's
   «every action» list (each call with its command or path, ≤ 2 min old), flags, footers, COVER. An action
   that is wrong, slow, wasteful or off-plan with no flag is a finding like any flag, and a script row too.
2. Anything that slows it, burns limit, re-runs a gate or check, or an existing mechanism not doing what it
   was built for (legend, delivery rounds, sieves, watcher signals, restarts) → its cause found that wake.
3. Pause at the safe point (S1 at once; waste arms it by itself, §5) → ledger row → fix with proof → resume.
   Lowest priority included: a defect of any size is fixed, never parked. No defect found → keep watching.
4. Every STAGE / ENDED → its audit agent spawned (§6); group closed → its ledger and the whole watch log
   re-read against [references/misses.md](references/misses.md) and §3a; anything missed is done now.
5. The next group starts in the same turn: `NEXT` names it, the keepalive's next command carries its `--group`.
A user question mid-turn is answered in the very next text, then the loop resumes in the same turn. The
Stop hook `watch-keepalive` holds the turn open between calls; it lets go only on the user's quoted
`--stop`, `R/.agent/live-watch/hold.json`, or every group done/failed.
Past misses and the guard each one now has: [references/misses.md](references/misses.md) — read at every
preflight and after every compaction (the session brief prints `WATCH ACTIVE` while a watch is on).

## 1. Preflight (once per watch)

- `R/.agent/live-watch-protocol.agent.md` read in full — user-approved; its standing order outranks any
  softer line, this skill's included. Absent → references/loop.md §Protocol core.
- Known classes = every class slug in `R/.agent/live-watch/*.agent.md` plus the seed set in
  references/classes.md; a stumble in one of them is a REPEAT.
- Stand healthy: `pnpm run doctor` exit 0; `node $G/group-control.mjs status --group <parent>:<i>` per group
  prints status, stage and copy path (it reads `state.json`, no API call).
- Parity agent asked for once (watchdog §6): «1 parity agent, <model>, lane-high, whole watch». A yes in this
  task's own prompt or the user's reply is the grant (a PROGRESS.md note is history). More stage audits
  ahead than review budget left → name the user's spawn-grant phrase once (references/loop.md §Stage audit).

Done when: a status line per group, a ledger per group `R/.agent/live-watch/<date>-<group-slug>.agent.md`,
and PROGRESS.md naming the state dir, the ledgers and the watch command.

## 2. Wait

First call: `node <kit>/skills/agentdeck-watchdog/scripts/watch-groups.mjs --state <dir> --repo <R> --group <parent>:<i> [--group …]`;
every later call: the command the footer's keepalive line and the Stop block print (units persist).
Foreground, `timeout: 600000`, `--max` per watchdog §2. Each group = one unit on its copy's transcript dir
(path read from `state.json` — copy dir names are shortened), plus panel events diffed from `state.json`,
watcher signals with their rule text, dev-watch restarts, the verify-ledger feed and `limit-runs.json` — one
wait over every group.

Done when: per watchdog §2; a group parent key `<cli>:…` shows `FOREIGN` in its footer (references/loop.md
§Foreign); the digest ends with a `COVER` line and every part of it is ✓ — a ✗ (blind source) is an S2
`watch scripts` row fixed before the next wait.

## 3. Classify

Ledger row first, per protocol §1: layer = panel server · panel web · kit (`apps/server/assets/kit/**`) ·
target project rules · global `~/.claude` · provider adapter · watch scripts. A WSIG row quotes its rule
id and text from the digest. A human-wait status (`question`, `decision`, `human-op`) outside merge, git
deletions and super-critical steps = S2 autonomy row: fix what made the group ask; the pending answer
itself goes to the user list in the report.

Done when: per watchdog §3, every row carrying one of the layers above.

## 3a. Economy watch — same bar as a bug

Every wake also asks: what did this stretch cost, and what was wasted? The script shows it — footer
`spent … · window … · legend rec/hit/Δ`, flags `LEDGER`, `GAP`, `RERUN`, `BURN`, `STORM`, `RUN`, `WINDOW`,
`CTX+`, `COVER`; each number is read, never skimmed. No bands: every waste flag owes a row (the next call
refuses otherwise) and arms its group's pause (§5); each is fixed at once like a bug:
- **Tokens / rate window** — BIG reads, REREAD, CTX+ growth, a brief or nudge repeating what the group has
  (`BRIEF`, escalation history), a whole-file read where a slice would do, a model tier above the step's need;
  `RUN` per finished group run (tokens, 5h/7d moved while it ran; heavy = hi), `WINDOW` at 80/90/95 %.
- **Time** — SLOW/TIMEOUT, a check run wider than its zone, NUDGE/ROUND #2+ (rework, hi), a wait on
  something that cannot change, RERUN (a check again with no edit in between), IDLE (turn over, no next one).
- **Restarts** — each `RESTART` names its file and who edited it (`edited by gN` = hi, arms gN); `STORM` at
  3+/h. A restart a live run had to wait out, or a crash loop, is a row.
- **Legend = the verify-ledger** (NOT the WSIG rule texts): first run full, then an unchanged
  area replays from it and only the changed area reruns — tests, lints, mustfail, gates. Per copy, from
  `<app-data>/verify-ledger/events.jsonl`: record vs hit vs delta, miss reasons. `LEDGER` hi = a
  replay missed; `GAP` = a check that ran with no ledger event from its copy (outside the legend — preload
  missing); a check the ledger never sees (go test, sieves) is a row. `LEDGER legend reinstalled A → B` → B
  checked against HEAD and the tree of `tools/verify-ledger` before the next wait (misses M-13).
- **The watch itself** — WSIG rule text resolves for every signal, footers are true (SAFE vs busy, real
  ages), the watch's own cost per wake stays small; a false or missing flag is a `watch scripts` row. The
  watch's own heavy runs (mustfail, multi-file vitest) wait while `node <R>/tools/heavy-queue-hook.mjs status
  <app-data>/heavy-queue` shows a group gate — they load the gate into timeout flakes (M-32).
- Each fix row names its gain in numbers (chars/tokens, seconds, restarts per hour) before → after.

Not fixable by the coordinator in this pass (another zone, too large, another provider) → a fix agent or the
parity agent gets the row the same minute (watchdog §6; spawn needs the user's yes for this task) — a row is
never left without an owner.

## 4. Fix — the project's bar

Per watchdog §4, plus AGENTS.md:
- Tests-block case linked and a recorded run: `node tools/tests-cli.mjs run --project <R> --case <g>:<id>`.
- `mustfail --files` on the bug-fix files only.
- A section's behaviour changed → its help document and `node tools/help-shots/sources.mjs <topic>`;
  user-visible → a changelog entry written now (the user commits later).
- A REPEAT → fixed at the enforcer every entry shares: grep each entry feeding that sink, one test per entry
  (misses M-14).
- Claude path = coordinator. A fix in a layer with per-provider copies → parity row + feed line the same
  minute; targets and their checks in references/loop.md §Parity.

Done when: the row's proof cell names the Tests-block run id and the mustfail verdict.

## 5. Safe point → pause → apply → resume

- The script pauses by itself (references/loop.md §Auto pauses): a waste flag arms the group (footer
  `ARMED pause at safe point (<flag> #ref)`) and it pauses the moment the turn is SAFE, the status pausable
  (`started`, `background`, `awaiting`, `pending`) and `state.json` fresh; BURN / STALL pause NOW; WINDOW
  arms every group. `--pause-at-safe <parent>:<i>` arms one by order. The digest shows `PAUSED` (HTTP 2xx),
  `PAUSE!` (refused → row) or `PAUSE-RACE` (2xx that did not hold → row before any new pause).
- A waste flag arms only the stage still running: from a conversation that is not the active one, or with the
  active one idle ≥ 10 min, it arms nothing (COVER note `no arm for …`), and an arm waiting for its safe point
  is dropped the same way (g5 25.10: an idle verify session's BIG paused the group 30 min).
- `PAUSED` names its resume: `resume: coordinator, once the row is fixed, due HH:MM — <command>`. Still
  paused past due → `UNRESUMED` once (never under `hold.json`): fix the row, run the command.
- An arm is removed only by its pause or `--disarm <parent>:<i> --row <id>`, the row's STATUS cell
  `fixed`/`verified`/`applied`/`OWNER decision`, or `expected`/`wontfix` (flag judged no waste, reason in
  the row) — a waste whose cause is fixed needs no pause.
- S1 the script did not catch → `node $G/group-control.mjs pause --group <parent>:<i> --s1 "<why S1>"` at once.
  Without `--s1` a busy group (turn running, a call / bg task / subagent open) is REFUSED with no request —
  a pause kills the in-flight call; not S1 → `--pause-at-safe <parent>:<i>` on the next watch call.
- Apply → restart only what a fix needs (references/loop.md §Restart) → `RESTART … cleared` in the digest
  → `node $G/group-control.mjs resume --group <parent>:<i> --repo <R> --note "<why paused>" --first "<do first>"`
  (`--force` skips the concurrent-group limit; the note reaches the group prompt — without it the group
  re-runs the check the pause killed, g5 25.10). It refuses while `R/.agent/live-watch/hold.json` exists or the inbox holds an `open`/`fixing` row:
  finish the row, or name in `--allow-open` only rows that cannot touch this group (misses M-12).
- The user pauses the watch → `group-control.mjs hold --reason "<the user's words>"`; the user's start command →
  `release --owner "<the user's words>"`, then resume.
- restart / relaunch / cancel of a group are the user's; the script refuses them. «Continue» of a group that
  stopped unfinished is an agent action (panel 25.10): `group-control.mjs continue --group <parent>:<i>`, same
  hold/inbox guard as resume.

Done when: per watchdog §5, the resume printed HTTP 2xx `sent` or `queued` and the next digest shows
the group busy on the same copy — or `restored` (paused in a human wait, no turn) and it shows that wait again.

## 6. Stage audit and end of a group

- Every `STAGE` / `ENDED` line carries `audit: spawn «review: watch audit <g> <stage>» (lane-high) on node
  …show.mjs --pack …` — spawn it that wake (a review spawn, standing exception; brief in references/loop.md
  §Stage audit). Its findings are rows like any flag. The line ends with the review budget left;
  `review cap … no grant` → audit that stage yourself from the same pack, never wait on the spawn's ask.
- Protocol §4: MR open, reviewer comments and conflicts handled, every S1/S2 `verified live` or `fixed, not
  re-hit`, every S3 fixed or `wontfix — why`, changelog entry present, metrics (protocol §5) in the ledger.
- Commit and push of the watch fixes: ask the user once, naming both operations.

Done when: every stage audit returned and its findings are rowed, the group's ledger holds its metrics block
and the inbox holds no non-terminal row for it.

## Red flags

- A turn ended while a group was not terminal and no user question was open (misses M-01).
- A closed group with the next one not started in the same turn (M-02).
- A user term answered without checking memory and past transcripts for its meaning (M-03).
- A report to the user with a claim ("works", "fast") and no number from the live source it names.
- A digest with no `COVER` line, or a ✗ left in it.
- A group paused while its footer said `busy`, short of S1; an arm disarmed by a row still open.
- A STAGE / ENDED audit line with no audit agent spawned.
- A copy path derived from the branch instead of read from `state.json`.
- A fix reached a running group without the restart or kit path it needs (references/loop.md §Restart).
- A REPEAT closed by pointing at the old fix, or fixed at one entry while a sibling entry feeds the sink.
- A resume with `--allow-open` naming a row that touches the resumed group.
- A parity row sitting in the queue with no feed line.
- The Bearer token echoed anywhere — `group-control.mjs` reads it itself and redacts every line.
- A write landed inside a group's copy from the watch side.
