---
name: project-onboard
description: "Use on the first substantive request in an unfamiliar project (no profile/rules/memory), or on 'study the project' / onboard — materializes .claude/project-profile.md."
---

# Project onboarding for Claude

One-time (then incremental) materialization of a **Claude-facing project profile**, so portable
global skills (refactor-code-health, tests, audits, contract-sync…) act correctly for THIS
project's structure, stack and conventions. SessionStart hook `project-onboard-check` re-triggers
this skill.

**UNIVERSALITY is the core principle.** The profile is **DERIVED from project facts**, not filled
from a fixed template.

Output artifact: `.claude/project-profile.md` — the "how to work in this project" map that global
skills read before acting.

Detail for each phase lives in `references/*.md` — read the named file right before running that
phase; don't load them all upfront.

## Workflow

1. **Phase 0 — skip check.** Profile exists and HEAD matches → skip; drifted → incremental update
   (step 6). Respect existing context (CLAUDE.md, .cursor/rules, AGENTS.md, memory) — link, don't
   duplicate. → Read `references/analysis.md`.
2. **Phase 1 — analysis (read-only).** Detect shape, stack per zone, structure conventions, real
   commands, ownership zones; large codebases → sampled recon (subagents only with a go-ahead); seed
   `.agent/glossary.md` (detail in the same `references/analysis.md`). Done when every workspace
   package/service appears in the map with path → purpose → stack → verify command; none marked
   TODO.
3. **Phase 2 — materialize `.claude/project-profile.md`.** Terse, link-based, only relevant
   sections (header+HEAD, package map, conventions, zones, bindings, links).
   Gate: every verify command entering the profile executed once first (or its `--help`/dry form),
   observed exit code noted beside it; a command not run is recorded marked `unverified`.
   → Read `references/profile.md` before writing.
4. **Phase 3 — project rules (delta only).** Record only project-specific rules on top of globals.
   Detail in the same `references/profile.md`.
5. **Phase 4 — bind global skills + hooks.** Bindings, not forks; frontend-architecture opt-in
   question (React/TS only); MCP/Figma links persisted; infra read-only; project hooks only with
   consent. → Read `references/bindings.md` before this step.
6. **Phase 5 — register + git hygiene.** Memory pointer; local-first via `.git/info/exclude`; no
   git mutations by me. **Phase 6 — keep current** incrementally (update HEAD/date, never
   re-analyze from scratch). → Read `references/registration.md`.

## Red flags — run against the finished profile

- Imposing a foreign template/stack instead of deriving from facts (the main anti-pattern).
- Carrying assumptions from another project without checking the code.
- Full re-analysis on every visit instead of HEAD check / incremental update.
- Duplicating root CLAUDE.md / `.cursor/rules` / memory content instead of linking.
- Forking global skills instead of a bindings section; binding irrelevant skills.
- Writing into read-only zones or committing `.claude/` without user permission.
- Profile as a wall of text: it's a working map, not a code retelling — terse, link-based.
