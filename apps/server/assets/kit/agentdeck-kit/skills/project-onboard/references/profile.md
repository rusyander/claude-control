# Phase 2–3 detail: profile structure + project rules

## Phase 2 — materialize `.claude/project-profile.md`

Assemble the profile tersely, with links, from facts. Include only sections relevant to the project:

1. **Header**: date, `HEAD` (for staleness check), project shape and type, main stack.
2. **Subproject/package map**: path → purpose → stack → verify command.
3. **Conventions** (or a link to existing docs/`.cursor/rules` if they're complete).
4. **Zones**: what we edit / what's read-only / infra — with paths (from Phase 1, not by default).
5. **Global-skill bindings** and **project hooks** (Phase 4).
6. **Links**: root CLAUDE.md, memory profile (if any), test kit, TASKS.md/.agent (whatever exists).

## Phase 3 — project rules (delta only)

Record ONLY project-specific rules on top of the globals — never restate globals. What exactly
depends on the project: one has "user rebuilds the stand / i18n keys in en+ru", another
"migrations forward-only / secrets via Vault", a third "public API frozen per semver".
Write what you actually found, not a boilerplate list.
