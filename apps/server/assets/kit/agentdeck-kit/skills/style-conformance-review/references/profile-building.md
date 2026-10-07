# Phase 1 — Building/refreshing the style profile (cached)

Three sources; on conflict, priority descending: **review history > code empirics > docs**
(docs lag real practice; reviewer comments are the freshest signal).

## 1a. Written rules

`CLAUDE.md` (root + every subproject), `.claude/rules/**`, `CONTRIBUTING*`, linter/formatter
configs (eslint, prettier, ruff, golangci, editorconfig...). Also record verification
commands (`npm run check`, `go vet`, `pytest`, etc.).

## 1b. Code empirics (mandatory — docs do not substitute)

For each subproject/language, sample-read 5–10 **recent, typical** files (recently changed:
`git log --name-only`) and record the ACTUAL patterns:

- type organization (inline / separate file / file naming: `types.ts` vs `kebab.types.ts`);
- constants and mappings (where they live, file naming);
- utils/helpers (file-per-function? barrels? shared modules?);
- styling (styled / css-modules / tailwind / inline — what's accepted);
- comments: language, density, style (why vs what), JSDoc or not;
- naming (files, dirs, components, variables), directory structure;
- tests (co-located / in tests/, naming), i18n (keys vs hardcode).

Large monorepo → parallelize with subagents (Explore) per subproject.
Docs-vs-code divergence → record both facts, flagging what the code actually does.

## 1c. Review-comment history (cross-chat)

Review/MR comments live on the forge and in SEPARATE chats — collect them:

- the forge first: `node <kit>/tools/review-harvest.mjs --since <60 days back>` from the repo
  root (GitLab, GET only) — every human note on own MRs; other forges → `gh` PR review comments;
- project memory: feedback-type entries (grep `type: feedback` in memory/);
- past session transcripts: `.../projects/<slug>/*.jsonl` — files are huge, NEVER read
  whole; only targeted grep for style markers ("review", "remark", "extract", "move",
  "against convention", "rename", "MR" — and the same stems in the team's language) and read small neighborhoods of hits.
  Sort and generalise per `profile-maintenance.md` ("constants don't go in utils" ← concrete case).

## 1d. Profile file format

Write `code-style-profile.md` into project memory:

- header: analysis date, commit hash, areas covered, `Harvested through <ISO>` (harvest watermark);
- sections per subproject/language; each rule tagged with its source
  (`[docs]` / `[code]` / `[review DD.MM]`) — on conflict the fresher/stronger source wins;
- «Review lessons» — rules with their `!N` refs, newest first, merged rather than duplicated;
- verification commands per subproject.
  Add a pointer line to MEMORY.md. Keep the profile compact (< ~150 lines): it's a working
  cheat-sheet, not documentation.
