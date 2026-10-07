---
name: resolving-merge-conflicts
description: 'Use when a merge, rebase or cherry-pick is stuck on conflicts — resolve each hunk by the intent behind both sides, verify, finish one approved git op at a time.'
---

# Resolving merge conflicts

A conflict is two intents colliding, not two texts. Reconcile the **intents**; the text follows.
This skill runs on an operation already in flight — starting a merge or rebase is never my initiative.

## 1. See the state before touching a file

`git status` · `git diff --name-only --diff-filter=U` · `git log --oneline --merge`

Know which operation is in flight and **which side is which**. During a rebase the sides invert:
`ours`/HEAD is the branch you are replaying **onto** (upstream), `theirs` is your own commit. Reading
those labels at face value is the single most common way to delete the right code confidently.

## 2. Find each side's intent

Per conflicted file, for both sides: `git log --oneline -3 <ref> -- <file>`, then the commit body and
the MR or issue it names. A hunk resolved from the diff alone is a guess dressed as a merge.

## 3. Resolve hunk by hunk

- **Keep both** wherever the intents do not actually collide — that is the default outcome. Taking a
  whole side is a decision that needs a reason, not a shortcut.
- Never invent behaviour that existed on neither side. The merge is not the place to improve the code.
- Generated artifacts — lockfiles, codegen output, snapshots — are regenerated, never hand-merged.
- Two intents that genuinely contradict → stop and ask, quoting both sides and naming the trade-off.
  Guessing here silently discards someone's work.

Gate: `git diff --name-only --diff-filter=U | xargs rg -n '^(<{7}|={7}|>{7})'` (the §1 conflicted
list) returns nothing — including inside strings and comments.

## 4. Verify — markers are the easy half

Run the project gate (`type-check && lint && test`). Then hunt the **semantic** conflict: both sides
applied cleanly, the result is still wrong. Anything renamed, moved, or given a new signature on either
side → check every call site, not just the conflicted files.

## 5. Finish it — one approved git op at a time

`git add` → `git rebase --continue` / `git merge --continue` / `git commit`. Each is a mutating op:
name it, get an explicit yes, run it, report. Leave the generated merge message alone unless asked.

**Never `--abort`, `reset --hard` or `checkout --ours/--theirs` wholesale on my own** — that can throw
away hours of the user's work. If aborting looks right, say why and let the user call it.

## Red flags — run against the finished resolution

- A whole side taken because it was faster to read.
- `ours`/`theirs` trusted literally during a rebase.
- A marker or a stray duplicated line left in a string or comment.
- Checks never run after resolving — markers gone is not the same as working.
- Lockfile hand-edited instead of regenerated.
- The merge finished without asking, or a conflict resolved by inventing a third behaviour.
