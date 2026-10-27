---
name: watchdog
description: "Use when watching running agent work live and fixing every deviation at once: "watch it live", "fix everything", "be the watchdog"; panel groups → agentdeck-watchdog."
---

# watchdog — live watch, every deviation fixed at once

A *tight loop* over running agent work (Claude Code sessions, their subagents, plain logs): ONE blocking call
waits on every watched unit, wakes on a flag, the coordinator rows it, fixes it with proof, and calls again.
Zero tokens while nothing moves; the turn stays open for the whole watch — the blocking call is the wait.

`S=<kit>/skills/watchdog/scripts` (`watch.mjs`, `show.mjs`, `selftest.mjs`). `P` = root of the repo
whose layers get fixed. Flags, footer, refs, tunables → [references/flags.md](references/flags.md). Ledger,
inbox, parity feed, final report → [references/ledger.md](references/ledger.md). Pause/resume/restart per
unit kind, long proofs, token levers → [references/levers.md](references/levers.md). AgentDeck split
groups → skill `agentdeck-watchdog`, which runs this loop with group units on top.

## 1. Set up (once per watch)

- State dir `<P>/.agent/tmp/watchdog/<slug>`: a project path, so a panel chat, a resumed session and a
  compacted one all find it again. The script refuses a state dir inside a watched copy (exit 2).
- One unit per moving thing: `--unit name=session:<id>` · `cwd:<abs dir the agent runs in>` ·
  `dir:<transcript dir>` · `file:<one .jsonl>` · `log:<plain text file>`. Units persist in the state; a
  later call adds or drops (`--drop name`) without repeating the rest.
- Ledger per unit, the shared inbox and (when parity applies) the parity queue + feeds exist —
  layout in references/ledger.md §Files. PROGRESS.md names the state dir, ledgers and the exact command.

Done when: the first call printed `wake=setup`, one footer line per unit and the BACKLOG of recent flags,
and every BACKLOG flag has an inbox row.

## 2. Wait — one blocking call per quiet stretch

```
node <kit>/skills/watchdog/scripts/watch.mjs --state <dir>
```

Foreground, Bash `timeout: 600000`, the SAME command line every call (cmd-duration learns a command by
that string). `--max` 120 by default, never raised: the digest lists EVERY action (call with its command or
path, hint, log line) one per line after the flags, and each one is read — a flag is where to look first, not
the only thing looked at.

- `wake=hi` — 8 s after the first hi flag (the settle collects what follows it) → §3.
- `wake=batch` — 60 s after the first mid flag with no hi → §3.
- `wake=max` — no flag in the stretch: its «every action» list is read like any digest, then the next call
  at once, no text in between.
- Exit 3 — another call holds the lock (a run from before compaction): the next call waits it out.
- Exit 2 `refused: N flag(s) … have no row` — §3 for the refs it names, then the same call.

The call registers the session for the Stop hook `watch-keepalive`: ending the turn is blocked with the exact
next command until the user's stop (`--stop "<their words, quoted>"`), `hold.json` or every unit ended
(references/flags.md §Rows owed, keepalive). A block = call again, never argue with it.

Done when: every call ends in exactly one of — next call (quiet), §3 (flags), §7 (end).

## 3. Every flag → a row first

Per hi/mid line: decide from the line itself; open the record only when the line leaves it open —
`node $S/show.mjs --state <dir> '#u:n'` (a positional read of that one record). Then the
row, BEFORE any fix: severity S1/S2/S3, class slug, owner layer, evidence ref, status `open`. A benign
flag gets its row closed `benign — why` the first time its class shows; the class list makes the next one
a one-word decision. A flag in a class already fixed = REPEAT: the earlier fix failed, reopen its row.

Done when: every owed ref of the digest is cited in a row (`#u:n` in its evidence cell; one row may cite
several refs of one class) — the next call checks it and refuses otherwise.

## 4. Fix at once, with proof

- S1 (wrong result, data/security risk, irreversible step ahead, burn loop — BURN, stuck unit — STALL) →
  pause the unit now (its lever: references/levers.md §Pause), then fix. A waste flag (RERUN, REPEAT, SLOW,
  BIG …) → pause at its next safe point, fix, resume. S2/S3 without waste → fix while the unit runs.
- The class, at the layer that owns it: reproduce on the real entry point, red-before → green-after,
  `node <kit>/tools/mustfail.mjs --files <fix file> --cmd "<check>"`; grep the shape in siblings and
  fix every copy.
- A proof longer than a minute runs `run_in_background: true` into a file under the state dir, added as a
  `log:` unit — its lines and its `EXIT` line wake the same watch call (references/levers.md §Long proofs).
- A fix in a layer with per-provider copies: the coordinator fixes the primary path, then the same minute
  appends the parity row + feed line (§6).

Done when: the row reads `fixed + proof: <cmd> red→green` (or `wontfix — why`), parity column filled.

## 5. Safe point → pause → apply → resume

Safe = footer `SAFE ended Ns ago` (turn ended, no open call, no background task, no running subagent)
AND the unit's own boundary (stage edge, copy clean or WIP-committed, any push or MR creation finished). At it: pause →
apply every ready fix → restart only what a fix needs → health check → resume → on the next occurrence of
each fixed class confirm it stayed fixed (row → `verified live`).
Several units: each has its own ledger and safe point; pausing one leaves the others running under the
same call.

Done when: every `fixed` row of that unit is `applied`, the unit resumed, and the next digest shows it busy.

## 6. One reserve parity agent

Only when §4 produces parity rows. ONE agent for the whole watch (spawning needs the user's yes for this
task — ask once, naming 1 agent, its model and effort); with no yes the coordinator ports each row itself at
the unit's next safe point, same proof bar. It waits on the parity feed with its own watch call
and ports each row the moment it lands; brief and feed format → references/ledger.md §Parity. The
coordinator watches the agent's done-feed as a `log:` unit; each `done` line → re-run its evidence, read its
diff, row → `ported + proof`.

Done when: every parity row is `ported + proof` or `N/A — why`, and the feed got its `STOP` line at §7.

## 7. Restore and end

- After compaction or a restart: PROGRESS.md → open ledger rows → the same watch command. Offsets persist,
  so records written meanwhile arrive in the next digest and nothing is read twice.
- The watch ends when the user stops it (the same command + `--stop "<their words>"`) or every unit ended
  (END / ENDED) with no open rows. Then: `STOP` to the parity feed, background proofs finished or stopped,
  final report from the inbox (references/ledger.md §Report) in the user's language.

Done when: the inbox has zero non-terminal rows except OWNER ones (the user decides them), and nothing this watch started still runs.

## Red flags

- A turn ended while a watched unit was still running, or `--stop` carried words the user never typed.
- A coordinator call ran with `--no-keepalive`, or `--ledger-dir` pointed away from the real ledgers.
- A sleep loop, a monitor or a background notifier stood in for the blocking call.
- A fix landed without its row, or a row closed without a command and its result.
- A pause sent while the footer said `busy` for anything short of S1 (the pause kills that turn).
- A transcript read whole where `show.mjs` by ref would do.
- The state dir sits in a session scratchpad or inside a watched copy.
- A long proof ran in the foreground and the watch stood still meanwhile.
- Two parity agents, or parity rows batched instead of fed one by one.
