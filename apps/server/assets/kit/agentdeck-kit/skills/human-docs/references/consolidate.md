# Mode CONSOLIDATE — scattered docs → one tree

Goal: after the pass, every fact exists once, in one place, and is true. Removing wrong pages is
worth more than adding new ones.

## 1. Inventory — metadata first, never bulk-read

Find human docs (`.md`, `.txt`, `.rst`, `.adoc`) outside `node_modules`, `dist`, `build`, `.git`,
`.agent`, `.claude`. For each: path · KB · mtime · last commit date+subject (`git log -1 --`).
Read nothing yet. Get headings cheaply: `Grep "^#{1,2} " -n` per file.

Exclude from the pass (belongs to `agentdeck-kit:doc-hygiene`, different audience): `CLAUDE.md`, `AGENTS.md`,
`.agent/**`, `.claude/**`, `docs/ai|agent|claude/**`.

## 2. Cluster by topic

Group by heading overlap + filename, not by folder. Typical clusters: setup/install · architecture ·
API · deployment · troubleshooting · contribution · domain glossary. A cluster of one is fine.

## 3. Canonical target per cluster

One file in `docs/` wins; the rest are sources. Pick the winner by **correctness**, not by size or
recency — the newest file is often a copy someone made to avoid editing the real one. Check the
disputed facts against the code before choosing.

## 4. Merge

- Take only claims verified against live source (`SKILL.md` §1). An unverifiable claim is dropped,
  not carried over "just in case".
- Conflict between two docs → resolve by reading the code. Never split the difference, never keep
  both with a "possibly".
- Keep the union of _facts_, not the union of _text_. Two paragraphs saying the same thing → one line.
- Preserve anything only a human could know: rationale, constraints, agreements, gotchas with a cause.
- Section order: what it is → quick start → how-to → reference → why it is built this way.

## 5. Delete

Per `SKILL.md` §3. Practical signals of a dead doc, all checkable without reading:

- filename contains `old`, `v1`, `copy`, `backup`, `draft` (or the word in the team's language), `_new`, or a date long past;
- last commit is a bulk move/rename with no content change since;
- untouched >14 days AND its subject was rewritten in code since (`git log --since` on the code path);
- describes a file, script, route, or command that no longer exists — the fastest and hardest proof;
- is a strict subset of the canonical doc after the merge.

## 6. Repair the graph

`Grep` the repo (docs, README, code comments, CI configs) for every deleted or moved path and fix
the links. A merge that leaves dead links has moved the problem, not solved it. Also check
`mkdocs.yml` / `docusaurus.config.*` / sidebar files if present.

## 7. Report

In the user's language; the English skeleton:

| before                   | after         | why                                                  |
| ------------------------ | ------------- | ---------------------------------------------------- |
| `docs/setup-old.md`      | deleted       | duplicate of `docs/setup.md`, its script was removed |
| `packages/api/README.md` | `docs/api.md` | moved, a 4-line stub left behind                     |

Counts: merged / deleted / created / untouched. Then the ask-list with reasons. Deletions are in the
working copy — say so explicitly; the user commits.
