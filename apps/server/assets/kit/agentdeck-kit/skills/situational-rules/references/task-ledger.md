# Task ledger — TASKS.md is about to be read or written

Why: proposed items were forgotten, finished ones never marked; the user lost track of what was chosen.
The rule alone was ignored, so the `task-ledger` Stop gate reads the transcript and blocks once when the
ledger lags behind it.

## What is owed, and when

- **Accepted = a line at once.** A task proposed and accepted ("yes", "do 1 and 3", "take them all", a
  multiSelect answer) or given directly is written BEFORE work starts — in the turn that starts it.
  Gate (a): accepted + work started (edit / spawn / commit) + no ledger write → block.
- **Finished = `[x]` in the same pass.** A work turn (a spawn or non-review hand-back, a commit, ≥3
  project files) ends with the ledger current. Gate (b): last hand-back / commit / project edit after the
  last ledger write → block. Nothing finished or accepted → end again with the same summary; never
  invent entries. Review lanes (`deep-review …`, `review: …`) finish nothing by themselves.
- Off: the user's words ("no ledger", "без TASKS") for that turn; `AGENTDECK_KIT_TASK_LEDGER=0`.
  Subagents, temp/scratchpad projects, pure Q&A are never judged.

## Where

- Main checkout keeping a root `TASKS.md` → that file. Otherwise `.agent/TASKS.md` (local, out of git).
- Linked worktree (`.git` is a file) or a panel group copy → ALWAYS `.agent/TASKS.md`: the root file
  is tracked there and would ride into the MR; writes to it do not count.
- One writer: the session that owns the ledger. A subagent's edit of any `TASKS.md` is denied once
  (repeat = the prompt assigned it); it reports each subtask's status in its return, the parent marks.

## Format — the list; details go to `.agent/PROGRESS.md`

```
## <task, outcome words> (YYYY-MM-DD)
- [ ] subtask
  - [x] sub-subtask — proof: command / commit / file:line
- [x] subtask — proof
```

- Text in the user's language; one line per item, no prose blocks.
- `[x]` = finished AND verified; partial stays `[ ]` with a short status after `—`.
- Every item `[x]` → move the whole task block to `.agent/archive/TASKS-done-<YYYY-MM-DD>.md` in the
  same pass (a project instruction-file lifecycle wins). Never delete the file or someone else's block.
- Grep the line + Edit it; never a whole read of a big file.
- PROGRESS.md carries the how (decisions, paths, blockers, proofs), never the list itself.
