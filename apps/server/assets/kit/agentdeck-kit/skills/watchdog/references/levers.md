# watchdog — levers per unit kind

## Pause, resume, restart

| unit runs as | pause | resume | restart after a fix |
|---|---|---|---|
| AgentDeck core task step | the human pauses the task (core command `pause`; the core observer stops waste itself) | core command `resume` | — |
| a subagent this session spawned | none mid-turn — it ends on its own | a fresh spawn with the ledger row as its brief | — |
| a background Bash task | TaskStop (its work is lost) | re-run it | — |
| a CLI session the user drives | none from here — the user's | the user's | the fix reaches its next turn |
| a service with a log | the service's own stop | its start command | restart, then the next log lines prove health |

A unit with no pause lever gets its fixes at its own turn boundary: global `~/.claude` and project rules
reach the next turn of any Claude Code session; code reaches it after the restart the code needs.
Pause only at `SAFE` — the turn the pause would kill must be already over; S1 is the one exception.

## Long proofs

```
node <check> > <state dir>/proof-<row>.log 2>&1; echo "EXIT $?" >> <state dir>/proof-<row>.log
```

run with `run_in_background: true`, then add `--unit p<row>=log:<that file>` to the NEXT watch call only
(units persist), and `--drop p<row>` once its EXIT line is rowed. Error lines arrive as `LOG!` (hi, 8 s), the
EXIT line as `LOG` (mid). The watch keeps every other unit covered while the proof runs.

## Token economy

- Quiet calls print footers only and need no reply text: the next call follows at once.
- `--budget` narrows digest lines and never drops one (flags.md §Shape).
- Open a record by ref (`show.mjs`), a slice of a file by offset; the transcript itself stays unread.
- One call watches every unit at once — many units, one wait, one digest.
- Rows are terse (one line, evidence = ref); the ledger and PROGRESS.md carry the memory, so compaction costs
  a re-read of two files, never a re-derivation.

## cmd-duration and the watch

The hook denies a main-session foreground command whose learned median is ≥300 s or that was ever killed;
watch scripts under `skills/*watchdog/scripts/` skip that verdict and keep the timeout advice
(`isBlockingWatch` in `hooks/lib/cmd-duration.mjs`). `--max` stays 120 all the same: it bounds how old an
action gets before the coordinator reads it, not what the hook allows.

## When the watch itself is wrong

A flag that misreads a record (false WORD, missed END) is a row with layer `watch scripts`: fix in
`scripts/lib/core.mjs`, add the record shape to `selftest.mjs`, run it, then prove the new check red:
`node <kit>/tools/mustfail.mjs --mutants <plan.json> --cmd "node scripts/selftest.mjs"` from the skill dir
(a mutant plan — the scripts have no base revision while uncommitted; `--files` once they do).
