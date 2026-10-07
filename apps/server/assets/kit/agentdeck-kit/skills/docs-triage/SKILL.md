---
name: docs-triage
description: 'Use when sorting ALL project docs in one pass — agent- vs human-facing, placing and pruning every file.'
---

# Docs triage — one pass over the whole project

Sorts **every** documentation file into exactly two worlds and leaves each one correct:

|                  | Agent                                        | Human                                                                     |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Lives in         | `<repo>/.agent/` (+ `CLAUDE.md`, `.claude/`) | `<repo>/docs/` (+ root README & co)                                       |
| Named            | `<slug>.agent.md`                            | `<slug>.md`, no suffix ever                                               |
| Language         | English, always                              | Russian by default; a second language only if the user asked              |
| Content & layout | skill `agentdeck-kit:doc-hygiene` §2         | skill `agentdeck-kit:human-docs` §2+§4 + `human-docs/references/style.md` |

`README.md` is to the human half what `CLAUDE.md` is to the agent half: the entry point, it stays in
the repo root and is never relocated into `docs/`.

The suffix is the whole point: after this pass the audience of any file is readable from its name
alone, so a doc can never quietly drift into the wrong world again.

Runs on the user's request — the `docs-order-hint` hook matches those phrases and routes here;
never as a side quest of another task.

## Order — sequential, never interleaved

1. Inventory → 2. Classify → 3. Place & rename → 4. Clean content → 5. Delete the dead →
2. Validate → 7. Report. Agent half and human half run **one after another** (agent first: it is
   mechanical and shrinks the pile), then deletion and validation run once over both.

## 1. Inventory — metadata only

All `.md/.markdown/.txt/.rst/.adoc` outside `node_modules`, `dist`, `build`, `.git`. Per file:
path · KB · mtime · `git log -1` date+subject. Headings via `Grep "^#{1,2} "`. **Read nothing yet.**

## 2. Classify — the only step where being wrong is expensive

Decide from name + location + headings. Signals: `references/classify.md`.

- Confident agent → agent world. Confident human → human world.
- Data (measurements, exports, node-ids, generated tables) → leave in place, never rename, never
  translate, never compress.
- **Not confident → do not move it.** Collect into the ask-list and continue. A wrong move breaks
  links and hides a doc from the person who wrote it; an unmoved file costs nothing.

## 3. Place & rename

- Agent → `.agent/<slug>.agent.md`. Exceptions that keep their exact names because tools and rules
  address them by name: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at the repo root, everything
  under `.claude/`, and inside `.agent/`: `PROGRESS.md`, `notes.md`, `ARCHIVE.md`, `TASKS.md`,
  `README.md`, `glossary.md`, plus `tmp/ archive/ backup/ screenshots/ .trash/`.
- Human → `docs/<slug>.md`. The root set (README & co) and the monorepo package-README stub rule
  live in `agentdeck-kit:human-docs` §2 — the single layout authority; follow it verbatim.
- Monorepo: one `.agent/` and one `docs/` at the repo root.
- Git-tracked file → `git mv` (history survives). **Never commit.** Untracked → plain move.
- After every batch of moves: `Grep` the repo for the old paths — docs, code comments, CI configs,
  `mkdocs.yml`/`docusaurus.config.*` — and fix the links. A pass that leaves dead links failed.

## 4. Clean content — while the file is open anyway

Agent docs: `agentdeck-kit:doc-hygiene` §2 + ladder §2a (delete → merge → link → compress → split).
Human docs: `agentdeck-kit:human-docs` §4 and its style reference (banned-phrase list).
Both, without exception: outdated statements deleted (not marked "outdated"), duplicated facts
reduced to one place + links, water removed, every claim re-verified against the code — an
unverifiable claim is deleted, never carried over. Translate agent docs to English as they pass.

## 5. Delete the dead — everywhere, including archive/ and .trash/

The user asked for this explicitly: a doc that is useless even as history does not deserve storage.
**Verify before deleting — three checks, all cheap:**

1. Subject no longer exists in the code (file/route/script/command gone) — `Grep`, not memory.
2. Nothing links to it (`Grep` its filename repo-wide).
3. Superseded: another doc covers the same ground, or it is a strict subset after the merge.

All three hold → delete. Two hold → propose in the ask-list. Deletions happen in the working copy
only; the user commits. **Never delete**: `LICENSE`, an accepted ADR (supersede instead), anything
outside the repo, anything you could not verify. Untouched >14 days is a _reason to check_, never a
reason to delete on its own.

## 6. Validate — mechanically, not by feeling

```bash
node <kit>/tools/docs-validate.mjs
```

Checks layout, naming, language, sizes, dead links, duplicates, empty stubs, staleness, secrets.
Not docs, secrets only: tool dot-dirs (`.github`, `.expo`…), `__fixtures__`/`testdata`, `.txt` outside
`.agent/`, non-README markdown under `src/` (product data the code loads — never move it). A README
beside a package manifest is the package page and stays.
Exit 1 = hard violations remain. The pass is finished when it exits 0, or when every remaining
line is explained in the report. Run it again after fixes — never claim a clean result unrun.

## 7. Report — Russian, compact

Table `before → after` per changed file · counts (moved / renamed / merged / deleted / left alone) ·
the ask-list with reasons · validator's final verdict · what was verified by running and what was
not. Full detail → `.agent/tmp/docs-triage-<date>.md`, not into chat.
