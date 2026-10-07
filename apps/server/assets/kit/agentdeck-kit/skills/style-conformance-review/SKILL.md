---
name: style-conformance-review
description: 'Use before editing code in a project (load its style profile) and once per finished batch before reporting done — self-review; review comments feed it.'
---

# Code-style self-review against the project profile

Purpose: write in THIS project's style from the first line, then — once the batch WORKS — re-read
the whole diff once through the eyes of its reviewer. The profile loaded before the first edit is
what keeps the review short: a convention applied while writing never needs a fix pass. One review
per finished batch or MR, never one per fix. Not a universal checklist — the **project style profile**: conventions are opposite
across projects (types in separate files vs inline; comments in Russian vs forbidden). The
profile is built once, cached in project memory, refreshed only when stale — no re-analysis
per run. Functionality is NOT checked here — only style, structure, conventions.

Profile build/maintain detail lives in `references/` — read the named file at the step that needs it.

## Phase 0. Load or build the profile — before the first edit

1. Find `code-style-profile.md` in **project memory** (memory dir from system prompt,
   `.../projects/<slug>/memory/`); pointer should be in MEMORY.md.
2. **Exists** → THIS tree's? Header hash unknown here (`git cat-file -e <hash>` fails) or covered
   paths gone → carried over from another repo → conventions get a full Phase 1, lessons are kept.
3. Lessons, both channels — detail and cases in `references/profile-maintenance.md`:
   - forge: `Harvested through` older than 7 days or absent, GitLab reachable →
     `node <kit>/tools/review-harvest.mjs --profile <profile>` from the repo root, fold, write the
     printed watermark into the header; exit 2 (no token, another forge) → one line, go on;
   - chat: `type: feedback` memories newer than the profile → each style-bearing one (user overrides
     of global rules included) becomes a rule linking it, never a copy.
4. Conventions: a section is re-checked (Phase 1, that section only) when the diff touches an area it
   does not cover or last checked >30 days ago — commit count alone is no signal.
5. **Missing** → Phase 1 (full analysis), then step 3 with `--since` 60 days back.

## Phase 1. Analyze project style (cached)

Read `references/profile-building.md`. Summary: three sources, priority on conflict
**review history > code empirics > docs**:

- 1a written rules (CLAUDE.md, rules, CONTRIBUTING, linter configs + verify commands);
- 1b code empirics — mandatory: sample 5–10 recent typical files per subproject, record
  ACTUAL patterns (types/constants/utils placement, styling, comments, naming, tests, i18n);
- 1c review-comment history from past chats/MRs (targeted grep, never whole transcripts);
- 1d write `code-style-profile.md` to project memory (format in the reference), pointer in
  MEMORY.md, keep < ~150 lines.

## Phase 2. Review the edits against the profile

1. Scope: `git status --short` + `git diff [HEAD] --stat`; if the user already committed,
   reconstruct the file list from conversation context. **Subagents' edits are also your scope.**
2. For each file, determine its subproject → apply THAT profile section, not a neighbor's.
3. Judge by the profile, not intuition: if the profile says "inline types are this project's
   norm", leave them inline. Only these checks are universal:
   - dead code / unused imports; **declared-never-read** — every export, type or field the diff adds
     has a reader beyond its declaration (`git grep -nw <name>`; eslint misses unused exports);
   - cascade leftovers (tails of the change);
   - copy-paste duplication; after extracting a shared piece, grep for the old shape (the third copy);
   - **stale claims, repo-wide**: neighbouring comments of touched blocks AND `git grep` of each changed
     symbol, key, endpoint and literal through comments, `*.md(x)`, locales, test names — the lying
     comment usually sits outside the diff;
   - a value owned elsewhere (backend constant, contract enum) copied here — read it from the owner or
     name the sync point beside it.
4. Found a code pattern contradicting the profile → verify against 2–3 neighboring files:
   if the profile is wrong — update the profile first, then fix the code.
5. Apply fixes (pure refactor, behavior unchanged). **Gate:** the profile's verification
   commands for touched areas exit 0 (buildable libraries — full check, warn that a rebuild
   is needed); red → fix before reporting.

## Phase 3. Maintain the profile

Read `references/profile-maintenance.md`. Gist: human review remarks — harvested from the forge
(`review-harvest`, the main channel) or relayed by the user — are sorted, and each style one becomes
or reinforces a rule in «Review lessons»; profile-vs-reality divergence → fix in the same run; refresh
header hash/date/watermark after updates.

## Phase 4. Report

Table "violation → where → fixed how" + what was checked and already conformed (shows
coverage, not just findings). Mention any profile updates.

## Red flags — run against the finished review

- "eslint is green so style is fine" — linters don't see type/constant placement, dupes,
  comment language/staleness, structure.
- Applied a from-memory checklist instead of the project profile — harmful in another project.
- Full re-analysis with a fresh profile (context waste) — or blind trust in a stale one.
- Lessons learned only from what the user relayed — the forge and the feedback memories hold the rest.
- Checked own files but skipped subagents' edits.
- Applied one monorepo subproject's rules to another.
