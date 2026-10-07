# Workspace — the `.agent/` folder, checkpoints, context

## `.agent/` working folder

- Root `.agent/` holds the agent's working notes; list it in `.git/info/exclude` (not `.gitignore`) so
  it stays local. A project's own established location wins.
- In a known project read `.agent/notes.md` first.
- `.agent/PROGRESS.md` = done+verified / in progress / left+blockers / key decisions / important
  paths. Update it at milestones and before a compaction; read it back after one — never ask the user
  to re-explain.
- Temporary files go to `.agent/tmp/`; retired files to `.agent/archive/`.

## Docs — the audience decides

- A doc only agents read (`AGENTS.md`, `CLAUDE.md`, `.agent/`) is compressed English.
- A doc people read (README, onboarding, ADR, API docs) is in the team's language: root `README.md`,
  the rest under `docs/`.

## Context budget — every token is re-billed on every later turn

- Search the symbol, then read with offset/limit; a whole file only when it is small. Never re-read a
  file unchanged since you read it.
- Run the project gate once at task end, batched (`type-check && lint && test`); a green re-run with
  no new edits proves nothing.
- Plan a todo list once, update in batches, close it with one write.
- The user's WHOLE task closed (or a context nudge fired) → the first line of the reply names the
  closed task and suggests `/clear`, then "continue from `.agent/PROGRESS.md`". A finished stage of an
  unfinished task is not closed: refresh PROGRESS.md and carry on. Stop only for a real decision or
  blocker, named as such.

## Before/after shots

A UI-visible fix gets BEFORE shots before the first edit and AFTER shots once the dev server is up —
start it yourself, under `.agent/screenshots/before-after/<task>/`. A check you cannot run live is
reported as not done, never passed as done.
