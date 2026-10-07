# Phase 4 detail: binding global skills, frontend doctrine opt-in, MCP/Figma, infra/hooks

## Skill bindings

Global skills are NOT forked (they're portable) — the profile records a **binding**: how each
relevant skill is parameterized here. Example set depends on project type:

- `agentdeck-kit:refactor-code-health` → this project's verify commands, style profile/linter, read-only zones;
- tests (`agentdeck-kit:unit-integration-tests`, `agentdeck-kit:playwright-e2e-tests` for frontend; backend → its own
  runner/fixtures) → how they run, where fixtures live;
- `agentdeck-kit:api-contract-sync` → where contracts live (OpenAPI/proto/GraphQL), who owns the backend;
- `agentdeck-kit:figma-parity` → only if there's UI and Figma: fileKey/nodes, stand URL, design frame width.
  Don't bind skills irrelevant to the project. Bind only skills that exist in the kit or the CLI's
  skills dir — an archived skill is not loadable, and a binding to one sends the next session after nothing.

## Frontend doctrine opt-in (React/TS frontends only)

If the project is a React/TS frontend, ASK the user (AskUserQuestion, in Russian) whether to apply
the [[frontend-architecture]] doctrine (FSD colocation, naming, routing, API layer, shared
primitives per DS, quality limits, lint), and resolve per-project variables: **router** (keep
existing React Router/Next/other vs TanStack Router for greenfield), **naming** (PascalCase +
`shared` kebab vs project convention), **styles** (SCSS modules vs project's choice),
**lint enforcement** (install ready configs vs not). Record answers in the profile as a
`frontend-architecture:` section — `applies: yes|no|partial` + chosen variables
(router/naming/styles/lint/package manager/monorepo). The skill reads this section when a frontend
task starts; if missing, it asks itself. Not a frontend → don't create the section.

## MCP and Figma (ask + persist links)

Determine whether design MCP/Figma and other MCPs are used. Ask if they should be used, and
**record base links/IDs in the profile** (Figma fileKey + reference node-ids, stand/dashboard/tracker
URLs) — so they're never re-asked. Figma only via the real Figma Dev Mode MCP (global rule).

## Infra/deploy (read-only, propose)

Docker/compose/CI present → don't rewrite; on explicit request propose targeted improvements
without breaking anything (infra read-only by default). Reusable frontend deploy templates live in
[[frontend-architecture]] `deploy/`. **Project hooks**: if a project hook would help (e.g. verify a
changed file with this project's command) — PROPOSE it and, on consent, write it into the project
`.claude/settings.json` (hooks run commands — never add without asking).
