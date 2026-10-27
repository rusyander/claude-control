# agentdeck-watchdog — auto pauses, stage audit, restart, kit, parity, edge cases

## Auto pauses (`scripts/lib/pauses.mjs`)

| armed by | pauses | why |
|---|---|---|
| a flag carrying waste — core ones in watchdog references/flags.md §Waste, group ones marked waste in classes.md | at the next safe point | the waste is rowed and fixed before the group repeats it |
| WINDOW (80/90/95 % of a limit window) | every group, at its safe point | every running group spends the rest of the window |
| BURN, STALL | NOW, mid-turn (kills the turn, files survive) | the loop itself is the cost; waiting for the turn end pays it |
| `--pause-at-safe <parent>:<i>` | at the next safe point | an order |

- Safe point = footer `SAFE` + status pausable + `state.json` parsed this pass (a stale snapshot never acts).
- One pause per chat and stage: the key `chatId + stages` blocks a second pause of the same stretch; a resume
  (`paused`/`held` → running, seen in the state diff) clears it, so the next waste arms the group again.
- `--disarm <parent>:<i> --row <id>`: refused with no `--row`, with no such row in `R/.agent/live-watch/*.md`,
  or with a row not `fixed`/`verified`/`applied`/`OWNER decision`. Refusal = exit 2, nothing changes.
- `PAUSE-RACE` (hi): 20 s after a 2xx pause the group's transcript still grew, or the panel still shows a
  pausable status. Between the SAFE read and the POST the panel may start the next turn (a nudge, a queued
  stage) — the pause then kills that fresh turn. Row it (class `pause-race`) with both refs, read the panel's
  pause path and check the copy's tree before any resume or second pause.

## Stage audit — one review agent per finished stage

`STAGE a → b` and `ENDED` print the spawn line; the stage's records are `show.mjs --pack <g> --from
stage:<a> --to stage:<b>` (`--from setup` when the stage began before the watch). Spawn: description
`review: watch audit <g> <stage>`, `lane-high`, one line before it naming count, model and effort. Brief:

1. Run the `--pack` command from the line; read every record of the stage (`--max` up if it says cut).
2. Find: checks rerun on an unchanged tree, gates mid-task, reads of what the group already had, waits on what
   cannot change, wrong tool or a slower path, a brief/nudge repeating state, a claim with no proof, work off
   the stage's plan, every token or minute spent with no result.
3. Each finding: record time + CALL/RES line quoted, class slug, owner layer, the fix that removes the class.
4. Deliverable `R/.agent/tmp/watch-audit-<g>-<stage>.md`, return ≤10 lines; `[return-format]` `[no-subagents]`,
   read-only: no edit anywhere, no git, no group control. Scratch files only under `<scratchpad>/audit-<g>-<stage>/`
   — audits run in parallel and share the scratchpad root (g1 26.10: `d1.txt`/`d2.txt` written over a sibling's).

The coordinator rows every finding the wake the return lands; a finding the digest never flagged is also a
`watch scripts` row (the flag that should have caught it). The spawn line ends with the session's review budget
(`hooks/lib/review-spawn.mjs`: 40, the 41st asks); at `review cap … no grant` the coordinator runs the same
`--pack` and audits the stage itself by this brief — an ask nobody answers would stop the watch. More audits
ahead than budget left (groups × stages) → the preflight line names the user's grant phrase once.

## Restart — what a fix needs before the group sees it

| fix in | reaches the group | proof before resume |
|---|---|---|
| `apps/server/**` | after dev-watch restarts the server; it defers while any run has a live process, so a paused group lets it through | digest `RESTART … cleared`, then `pnpm run doctor` exit 0 |
| `apps/web/**` | Vite HMR, at once | the page the fix touched, live |
| kit `apps/server/assets/kit/**` | composed per run (`kit.runExtras` in `runRoute`), so the group's next turn; kit conventions (version, variants, pins) → `R/.agent/code-map-kit.agent.md` | the next turn's transcript shows the new text (`show.mjs` by ref) |
| global `~/.claude` (skills, hooks, rules) | the next turn of a Claude group; in builtin steps a global skill wins over a same-named kit skill (`skillIdFor`) | the hook/rule fires in the next digest |
| target project `.claude` / `.agent` in the group's copy | that copy only — the fix belongs to the project repo; the copy gets it by the group's own flow, never a write from the watch | — |

The coordinator restarts the server itself when a fix needs it through dev-watch:
an edit restarts once no run is live; a `dev-restart.request` file in the panel's app-data dir asks for it
now. A process-pattern kill takes live sessions with it — the dev-watch path keeps them.

## Parity — targets and checks

Targets: codex, gemini, qwen, continue, goose, kimi, cursor, opencode, aider, local models (Ollama), and the
contour `domains/platform/**`. Per target the row says `ported + proof` or `N/A — why`. Contour fixes prove
on `node tools/qa/check-platform-wire.mjs` and `check-platform-run-env.mjs`; layer flags on
`check-run-layers.mjs`; a CLI not installed here → code + unit test, marked unverified with the reason.
Provider facts: `R/.agent/provider-formats.agent.md` (the ONE entry touched), immutable rules in
`R/.agent/universal-providers.agent.md`. Queue and feeds: `R/.agent/live-watch/parity-queue.agent.md`,
`parity-feed.log`, `parity-done.log` (watchdog references/ledger.md §Parity).
The parity agent's write zone = provider adapters and the contour; the coordinator's = the Claude path. A
row whose fix needs both is split into two rows before it is fed.

## Foreign groups

A parent key `<cli>:<id>` = the group runs on another CLI. A CLI whose transcripts `scripts/lib/foreign.mjs`
maps reads like a Claude group (footer `FOREIGN <cli> — transcript mapped`); any other gets footer
`FOREIGN <cli> — status + signals only` and COVER counts it `status-only`; STATUS/STAGE/NUDGE/WSIG still
arrive from `state.json`. Its own log, when the CLI writes one, joins as `--unit <name>=log:<file>`.

## Several groups

Names are `g<index>` under one split, `g<index>-<parent6>` across splits. One call watches all; each group
has its own ledger, its own arm and its own resume. A group that ENDED is dropped from the state
(`--drop g<i>`) once its ledger closes.

## Protocol core

When the protocol file is absent: never dormant (blocking wait inside the turn) · every deviation, the
smallest included → ledger row → fixed at once with proof · loop safe point → pause → apply → restart →
resume → confirm no recurrence · S1 pauses at once · Claude path = coordinator, other providers = ONE
reserve parity agent fed row by row · each group its own ledger and safe point · final report = inbox
retold short, in the user's language.

## Scripts' own check

`node <kit>/skills/agentdeck-watchdog/scripts/selftest-groups.mjs` — a stub panel on 127.0.0.1:0 and a
fake token generated at runtime; it prints its pass count and exits 1 on any failure.
