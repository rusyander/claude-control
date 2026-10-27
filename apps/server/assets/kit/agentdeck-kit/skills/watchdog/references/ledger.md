# watchdog — ledger, inbox, parity, report

## Files

All under `<P>/.agent/live-watch/` (a project's own existing layout wins — AgentDeck keeps exactly this one):

- `<YYYY-MM-DD>-<unit-slug>.agent.md` — one ledger per unit (group, session, task): its rows, its metrics.
- `inbox.agent.md` — EVERY finding, one line, the moment it is seen: unit stumbles, own readings, a fix
  agent's «left for the coordinator» items, the user's remarks. The final report is this file retold.
- `parity-queue.agent.md` — one row per primary-path fix that other providers must mirror.
- `parity-feed.log` (coordinator appends) and `parity-done.log` (parity agent appends) — append-only, one line
  per event, so a `log:` unit reads them by offset. Tables are edited in place; logs never are.

PROGRESS.md points at the state dir, every ledger and the watch command; it is updated after each fix.

## Ledger row

```
| # | time | sev | class | layer | seen (evidence ref) | root cause | fix (files) | parity | proof (cmd → result) | status |
```

- sev: **S1** stop now — wrong result, data/security risk, irreversible step ahead, burn loop, stuck unit ·
  **S2** degrades the result or the unit's autonomy (needless human ping, retries, wrong tool) · **S3**
  optimisation, cosmetics, cost. The smallest deviation gets a row: a slow command, a wasted read, a stale
  prompt line.
- class: a stable slug reused across units and days (`shell-alias-unasked`, `cold-brief-bloat`). Known class
  seen again = REPEAT → reopen the earlier row; its fix was not the class fix.
- layer: whichever owns the behaviour — the product's server/web/shipped kit, the target project's rules,
  global `~/.claude` (skills, hooks, rules), a provider adapter, or the watch scripts themselves.
- status: `open` · `fixing (<agent id>)` · `fixed` · `applied` · `verified live` · `REPEAT → reopened` ·
  `wontfix — why`. Proof cell holds a command and what it printed, never «passes».

## Inbox row

```
| id | what (≤12 words) | source | owner | when | status / proof |
```

owner: me · agent id · parity · OWNER (the user decides). when: `earlier` (a fix existed before it was seen — a repeat) · `now`
(fixed in this watch) · `—` (not fixed). Terminal statuses only at the end: `verified live`, `fixed + proof`,
`wontfix — why`, `OWNER decision`. Sweep at every safe point and before any turn would end: rows without
an owner = 0.

## Parity

Queue row: `| P-n | fix row id | files (primary path) | behaviour to mirror | status |`; feed line:
`<ISO time> P-n open <one-line behaviour>`; done line: `<ISO time> P-n ported|N/A <proof or reason>`; the
coordinator's last feed line at watch end: `STOP`.

Parity agent brief (one spawn, `lane-high`, model never weaker than the coordinator's):
1. Read the queue; take every `open` row now.
2. Per row, per target in the project's provider list: `ported + proof` (red→green on that adapter's real
   path) or `N/A — why`; an adapter with no CLI here → code + unit test, marked unverified with the reason.
3. Append the done line, then wait: `node <kit>/skills/watchdog/scripts/watch.mjs --state <P>/.agent/tmp/watchdog/parity --unit feed=log:<feed> --batch 10`
   (the unit is added on the first call only; later calls pass `--state` alone). A new `open` line → step 2.
4. `STOP` → final report ≤10 lines to its deliverable; then end.
Its prompt carries the literal `[return-format]` and `[no-subagents]` tags and the project's write bans.

## Report

From the inbox, short, in the user's language: total problems · fixed earlier (repeats) vs fixed now · left
for the user (one line each, the decision named). Per unit (ledger end): stops (S1 / safe point), stumbles
per class, REPEATS (target 0), new classes, time to fix, burn per stage.
