---
name: frontend-architecture
description: 'Use for React/TS frontend work — index routing to rule modules; opt-in via project-profile binding, project idiom wins.'
---

# Frontend doctrine (index)

Thin router into my frontend rules. This file only: checks applicability, routes to the rule module for the current task, lists hard invariants. Detailed rules live in `references/*.md` — load ONLY the modules relevant to the task, never all at once. Source of truth is this directory.

Process detail (Step 0 question list, conflict protocol, adjacent policies, configs/scaffolder, metrics, red flags) → `references/process.md`. Version history → `references/changelog.md`.

## Step 0 — applicability (MANDATORY before edits)

1. Read `.claude/project-profile.md` → `frontend-architecture` section.
2. Binding exists → follow it, don't re-ask. `applies: no` → don't impose, use project conventions. A binding line restating a rule that `references/changelog.md` later reversed is stale — the newer NON-NEGOTIABLE module wins; name the stale line to the user once (e.g. a canon whose "screen-family `<slice>.module.scss`" line is the v2.4 allowance v2.5 reversed).
3. No binding → detect existing setup, then ask the user (AskUserQuestion, in Russian) whether/how to apply; record binding via [[project-onboard]]. Full checklist → `references/process.md`.
4. Doctrine vs project conflict → show the concrete conflict, ask per point; DEFAULT: project wins.

## Routing (read ONLY modules for the current task)

| Task                                                                                   | Module                                       | Delegate to skill                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| Components, folders, naming, barrels, imports, FSD                                     | `references/structure.md`                    | —                                     |
| **Folder per component, satellites, grouping a flat dir**                              | **`references/colocation.md`**               | —                                     |
| **`.module.scss` ownership, splitting a shared sheet**                                 | **`references/styles.md`**                   | —                                     |
| Queries, cache, mutations, query keys                                                  | `references/api.md`                          | [[api-contract-sync]]                 |
| Screens, routes, loaders, preload                                                      | `references/routing.md`                      | —                                     |
| Raw tags → primitives, DS tokens, Figma                                                | `references/ui.md`                           | [[figma-parity]]                      |
| Size/splitting/props/comments/mock/optimization                                        | `references/quality.md`                      | [[refactor-code-health]]              |
| Frontend security                                                                      | `references/security.md`                     | [[dependency-risk-review]]            |
| "Why these contested rules"                                                            | `references/adr.md`                          | —                                     |
| Lint enforcement / config insertion                                                    | `references/lint-enforcement.md` + `config/` | —                                     |
| New entity from template                                                               | `templates/` (plop)                          | —                                     |
| Package manager, package.json, vite/test, monorepo                                     | `references/tooling.md` + `config/`          | —                                     |
| Docker/nginx/compose for frontend, CI                                                  | `deploy/` (templates)                        | infra read-only: propose, don't apply |
| Opt-in flow, conflicts, adjacent infra (i18n/tests/Storybook/docs), metrics, red flags | `references/process.md`                      | —                                     |

Multi-domain task → pull several modules.

## Hard invariants (apply in all modules)

1. **Project idiom wins.** Adapt to existing router/structure/ESLint/libs first; free doctrine choice only on greenfield. New dependency only with explicit consent.
2. **Git mutations: the global rule applies** (`git-guard` enforces); changes stay in the working copy — the user commits.
3. **Refactor ≠ behavior change.** Baseline (tests+snapshots) before/after; found bug → report, don't fix silently.
4. **Rules carry exceptions.** Threshold/contested rules read as "rule · signal · when NOT to apply"; letter-over-readability violates the spirit.
5. **Monorepo per profile.** Check project shape in project-profile; apply configs per-package, shared at root. Details → `references/tooling.md`.
6. **Adjacent infra (tests/Storybook/i18n) absent in project → ask before introducing**; delegate execution to the skills listed in `references/process.md`.
7. **Design it twice.** A new module interface — hook, context, store slice, public API — gets 2–3 _radically_ different shapes sketched before one is picked, judged on depth (much behaviour behind a small interface) and on what each hides from callers. UI/UX questions instead of interface shape → skill `agentdeck-kit:prototype`.
8. **Closing gate.** Every doctrine-guided edit batch ends green on the project gate: `typecheck && lint && test` (the project's own commands).
9. **One folder per component — NOT negotiable, no exception clause.** A component and ALL its satellites (`.types.ts`, `.constants.ts`, `.module.scss`, `.stories.tsx`, `.test.tsx`) sit in one PascalCase folder; no barrel inside it; fold the moment a directory holds ≥2 components. Read `references/colocation.md` before creating or moving any component file. Invariant 4 does not soften this and invariant 1 does not waive it — a flat directory is unfinished work, not a project idiom.
10. **One stylesheet per component — NOT negotiable.** Outside `shared`, a common `<slice>.module.scss` serving several components is forbidden; each component owns its `<Component>.module.scss`, and duplicating rules between components is the accepted price of decoupling. Read `references/styles.md` before touching styles.
