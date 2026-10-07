---
name: refactor-code-health
description: 'Use when asked to refactor or clean a codebase (dead code, simplify) — staged audit, prioritized report, applied on approval, behavior unchanged.'
---

# Refactor review: codebase health

Goal: simpler, more readable, more modular code — **with behavior unchanged**. Staging is strict: full audit + prioritized report first; apply only approved items, in small steps, verifying after each.

References (same dir, read on demand):

- `references/audit-passes.md` — the 4 audit passes in detail. Read BEFORE Phase 1.
- `references/approval-apply.md` — findings table format, approval flow, apply rules, red flags. Read BEFORE Phase 2.

## Phase 0. Scope & context

1. Agree scope with the user: whole project / subproject / module. For a large project, propose starting with one area.
2. Load the **project style profile** ([[code-style-profile]] in project memory — created by skill style-conformance-review; if absent, build it per that skill's Phase 1). Project idioms WIN over generic best practices: if the project prefers "three similar lines over premature abstraction" — don't DRY everything.
3. Verification commands (type-check/lint/tests/build) — from the profile. No tests → say honestly the safety net is weak and propose only low-risk edits.
   Backend in scope (Go/Python/SQL/Helm): the audit reads freely; applying needs the user's edit yes for THIS task, asked with the Phase 2 approval — never implied by it. Backend passes add the project's backend canon and the dead-code tools of that language — commands and no-install fallbacks in `references/audit-passes.md` §1a.
4. **Scope before you scan.** `git log -n 400 --format= --name-only -- <scope> | sort | uniq -c | sort -rn` → the churn hot-spots. A file nobody has touched in a year is working code; health matters where edits keep landing. Audit hot-spots first, and name what you deliberately skipped. YAGNI binds the audit too.
5. **A settled decision is not a finding.** Check `.agent/notes.md`, ADRs and the profile before flagging: a pattern chosen on purpose gets re-argued once, with the trade-off named — never re-opened every audit.

## Phase 1. Audit — 4 passes

Read `references/audit-passes.md` first. I run the passes in sequence; parallel subagents only on the
user's go-ahead for THIS refactor (`CLAUDE.md` → orchestration). Passes:

- **1a. Dead code** — tooling (knip/ts-prune/...) or targeted search; check DYNAMIC usages before calling anything removable.
- **1b. Duplicates** — copy-paste + semantic dupes; collapse along dependency direction; rule of three.
- **1c. Simplification** — logic-free wrappers, nesting → guard clauses, YAGNI, cascade tails (orphaned imports/props/types/styles).
- **1d. Modularity & portability** — layer boundaries, "lift and move" test, hidden coupling.

## Phase 2. Findings & approval

Read `references/approval-apply.md`. Prioritized table (finding → where → action → risk/gain), grouped safe/local/structural. User picks groups interactively. No approval → audit only, no changes.

## Phase 3. Apply — small steps

Per `references/approval-apply.md`: prove the suite ASSERTS each function before restructuring it (change its result → a named test red → restore, byte-compare); one logical step → verify → next; no behavior changes or silent bug fixes; don't break public APIs without approval; finish with full verification, style self-review, and a numeric summary (deleted/collapsed/simplified + what was deliberately left).

## Red flags — run against the finished refactor (full list in approval-apply.md)

Big-bang batches without verification; refactoring for its own sake; deleting static-only "unused" finds; generic best practice over project idiom; mixing refactor with fixes; abstraction heavier than the dupes it replaced.
