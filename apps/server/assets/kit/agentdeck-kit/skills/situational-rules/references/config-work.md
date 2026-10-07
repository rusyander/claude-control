# Config work — an instruction file, skill, rule or MCP/plugin config is about to change

Auto-loaded text is re-billed EVERY turn; this keeps it cheap and honest.

## Auto-loaded layer

- Root + package `CLAUDE.md` / `AGENTS.md`, `@`-imports, `.claude/rules/**` sit in the cached prefix.
  Never `@`-import a doc >8 KB — link it, read on demand.
- Byte-identical copies across packages → `claudeMdExcludes` in the project's `.claude/settings.json`
  (or `settings.local.json` to keep the repo untouched); `context-budget` reports the total over ~8k
  tok at SessionStart and names the canonical copy of anything excluded.
- Situational text belongs in a rule delivered at its trigger, not in the always-loaded file. In this
  kit: `skills/situational-rules/references/<name>.md` + a trigger in `hooks/lib/rule-injector.mjs`,
  changed together. Over `MAX_RULE` (2400 B) → `BIG_RULES`, or split.

## Skills, agents, plugins

- Each save re-sends the whole skill listing: decide the full set first, write back to back, no
  re-saves to verify.
- A retired skill is moved to an archive folder, never deleted; nothing may still route to it.
- A noisy built-in skill → `skillOverrides` (`name-only` / `user-invocable-only`), not deletion.

## MCP

- Tool names sit in the prompt every turn once a server attaches (~350 names ≈ 3.5k tok); scoping
  limits WHICH projects pay, not whether. Attach a server where it is used.
- Registry-launched servers run pinned (`npx pkg@x.y.z`, image `:tag@sha256:…`), never `latest`.
- Credentials never go into a config file or `.env`: integrations are connected in the panel
  (Settings → Integrations) and reached through its bridge.

## Self-modification

An agent edit of the CLI's own settings file may be refused by the permission mode — never route
around it (sed, node, a copy). Hand the user a script instead: dry-run by default, `--apply` with a
backup, idempotent, skipping a file changed mid-run.
