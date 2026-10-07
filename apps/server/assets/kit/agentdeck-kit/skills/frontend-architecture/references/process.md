# Doctrine process detail (opt-in flow, policies, meta)

Moved from SKILL.md index. Load when running Step 0 in a new project, resolving conflicts, or introducing adjacent infra.

## Git and forges

The doctrine sets no git policy of its own: the global CLAUDE.md §Git & GitLab writes rules (reads free, a mutating op only when the user asked or approved, merge never) plus whatever grant the project records (a ticket pipeline, a standing grant in project memory). Forge reads (GitLab/GitHub MCP) are free.

## Step 0 — applicability (full detail)

1. Read `.claude/project-profile.md` → `frontend-architecture` section.
2. Binding exists → work by it, don't re-ask.
3. No binding → detect existing setup (ESLint/Prettier, router, i18n, test runner, Storybook, package manager, monorepo?, `.cursor/rules`/`AGENTS.md`, structure) and ask via AskUserQuestion (in Russian): apply doctrine (yes/no/partial); router (existing vs TanStack greenfield); naming; styles; lint config; package manager (pnpm preferred for greenfield, else existing); is Figma/design-MCP used and which base links/fileKey to remember. Record binding + links via [[project-onboard]] (Phase 4).
4. Conflict protocol: where doctrine diverges from the project — show the concrete conflict, ask point by point. DEFAULT on conflict: project wins; doctrine adds only where non-conflicting. Project has own rules → ask which to follow BEFORE edits. Result goes into the binding.
5. `applies: no` → don't impose; follow project conventions.

## Monorepo

Check project shape (monorepo vs single package) in project-profile; apply rules/configs per-package, shared ones at root with `extends`/workspace. Details → `references/tooling.md`.

## Adjacent policies (ask BEFORE introducing if absent in project; delegate execution)

- i18n: strings via i18next, no hardcode; own locale namespace per page/feature, not one file; en+ru in sync → [[i18n-audit]].
- Tests: no runner → don't add silently, ask → [[unit-integration-tests]] / [[playwright-e2e-tests]]; after a non-trivial fix — regression test [[bug-regression-test]].
- Storybook: present → cover new shared components; absent → ask → [[storybook-stories]].
- Docs: classify audience — agent-facing docs/audits/maps → `.git/info/exclude` (local, never commit); human/project docs (README, onboarding, ADR) → write properly, user commits. Based on actual code, on explicit request only → skill `agentdeck-kit:human-docs`.
- Before/after screenshots + Playwright for visible changes: mandatory cycle — global CLAUDE.md §Before/after screenshots.
- Finalization: before MR — [[style-conformance-review]] → [[prepare-mr]] / [[changelog-builder]].

## Configs & scaffolder

- `config/` — `eslint.config.mjs.txt`, `tsconfig.base.json.txt`, `prettierrc.json.txt` (each copied without `.txt`), `.dependency-cruiser.cjs`. Insert only with consent (new devDeps); extend/override per-project.
- `templates/plopfile.mjs` — `component`/`feature`/`entity` generator in doctrine shape. Add to project on request; makes the rule the path of least resistance.

## Measuring benefit

After applying in a repo — count review nits (style/structure) before vs after. Not decreasing → cut the rule, don't hoard. Every N tasks reconcile doctrine with project reality (changelog records evolution).

## Red flags (top-level; detailed ones in modules)

- Editing frontend without passing Step 0 (binding/conflict).
- Any mutating git operation (violates the immutable rule).
- Overwrote existing ESLint/router/i18n/structure instead of the conflict protocol.
- Introduced tests/Storybook/i18n infra into a project lacking them without asking.
- Added a dependency without consent. Loading all modules at once instead of the relevant ones.
