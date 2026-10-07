# Mode B — Sweep (periodic inventory, prune, delete)

Run when: the user asks to clean up; `.agent/` is visibly bloated; starting a phase; or the session-start nudge fires. Goal — nothing stale is ever read by an agent, nothing dead occupies disk.

## B1. Inventory (cheap, no file reading)

Never open the files to classify them. Use metadata only:

```
list agent docs with size + mtime; find dirs; du the .agent tree
```

Build a table: path | KB | age | verdict.

## B2. Staleness signals (classify without reading)

Mark **STALE** when any holds:

- Title/name references a task, batch, or branch that is closed/merged (check `git branch --merged`, `git log`).
- References files/paths that no longer exist.
- Explicit DONE / IMPLEMENTED / completed (in any language) marker and no pending items.
- Superseded: a newer doc covers the same topic.
- Untouched > the dead threshold (14d, SKILL §1 — `TTL_D`) AND not a durable knowledge doc (`notes.md`, `PROGRESS.md`, `glossary.md`, profile, conventions).

Durable docs (`notes.md`, `project-profile.md`, convention/architecture memory) are **never** stale by age alone — only when factually wrong.

## B3. Three-tier action — this is the safety line

**Tier 1 — auto-delete, no asking** (agent-generated, disposable, git-excluded only):

- `.agent/tmp/*` older than 7 days (`TTL_D.tmp` — half the dead threshold: disposable by construction)
- `screenshots/before-after/<task>/` where the task is closed/merged AND older than 14 days
- generated audit/report artifacts already superseded by a newer run
- empty dirs left behind

**Tier 2 — archive, i.e. delete on a 14-day delay** (might still be needed this fortnight):

- completed-task docs with knowledge value → move to `.agent/archive/`, add one line to `ARCHIVE.md`
- superseded memory files → hook line moves to `ARCHIVE.md`
  Anything under `archive/` is **never auto-read**, which is what stops stale docs from re-entering
  context, and `doc-hygiene-autoclean` **erases it 14 days after its last touch**. Only the one-line
  `ARCHIVE.md` entry survives — so write that line to be readable alone, and lift anything genuinely
  durable into `notes.md` BEFORE archiving the file it came from.

**Tier 3 — ask first, always** (never auto-delete):

- anything the user created or edited (`TASKS.md`, human docs, specs)
- anything tracked by git
- anything outside `.agent/` / project memory
- anything you did not create and cannot prove is dead
  Surface these as a list with the reason; let the user decide.

**Hard rule:** if what you find contradicts how it was described, or you didn't create it — surface it, don't delete it.

## B4. Windows / safety notes

Use the project's safe-io helpers where they exist (`backupEntry`/`removeEntry`/`copyRecursive`) rather than raw `rmSync`/`cpSync` — Cyrillic paths and case-only renames break naive calls. Report a one-line summary of what was deleted/archived and reclaimed size; never a raw file dump.

## B5. Sweep output

Report in Russian, compact:

- deleted (Tier 1): N files, X MB reclaimed
- archived (Tier 2): N docs → `archive/`
- needs your decision (Tier 3): list with reasons
  Full detail → `.agent/tmp/doc-sweep-<date>.md`, not into chat.
