# claude-control — agent map

Auto-loaded every session → tight and English. Humans read [docs/SETUP.ru.md](docs/SETUP.ru.md);
answers to the user stay Russian.

**Read on demand, not loaded here:** [.claude/gotchas.md](.claude/gotchas.md) — traps already paid
for; read the relevant entry BEFORE touching pricing/analytics, enable-disable of
hooks/rules/groups, sessions & chat resume, MCP OAuth, secrets, help texts, Windows file ops.
[.agent/universal-providers.agent.md](.agent/universal-providers.agent.md) — capability map and
IMMUTABLE RULES; read BEFORE any provider-layer edit.
[.agent/provider-tools.agent.md](.agent/provider-tools.agent.md) — model catalog, environment
transfer, format check vs published schemas.

**"Doesn't start" / "doesn't work on my system" → start at Triage, not at the code.**

## What it is

Local web panel over Claude Code's own configuration: reads and edits `~/.claude` (rules, skills,
hooks, permissions, MCP, env), transcript analytics, full CLI chat, isolated sandbox. Nine more
CLIs (codex/gemini/qwen/continue/goose/kimi/cursor/opencode/aider) are configurable, Claude is the
default and the only verified one. No database — **source of truth = Claude Code's files**; most behaviour follows.

- `apps/server` — Fastify, port 5178; reads/writes `~/.claude`, spawns `claude`
- `apps/web` — React + Vite, port 8888; proxies `/api`
- `packages/contracts` — shared types + zod schemas
- `tools/` — `doctor.mjs` (environment check), `qa/*.mjs` (Playwright runs)

Needs **Node 22.6+** (server runs with `--experimental-strip-types`), pnpm 10, `claude` in PATH.

## Triage in 60 seconds

```bash
pnpm doctor                                # node, claude in PATH, config dir, account access
                                           # (incl. macOS keychain), ports, deps — exit 1 = blocking
curl http://127.0.0.1:5178/api/location    # which dir, which rule chose it, what's missing
curl http://127.0.0.1:5178/api/system      # platform, home, shell
curl http://127.0.0.1:5178/api/credentials # access source (token is NEVER returned)
```

`/api/location` answers most questions on its own. No match below → narrow: server vs front (`curl`
the API), panel vs CLI (`claude --version` in the terminal that started the server). Fixed →
**verify by running**, then report what was verified and what stayed unverified.

Fix without asking: project code, deps, build config, launch env. Ask first: files in `~/.claude` —
the user's real config, not test data (reading is free; hand-editing for diagnosis is not, go
through the panel's API).

QA runs (need `pnpm dev` up + `pnpm qa:setup`): `tools/qa/audit-layout.mjs` (layout, all pages),
`check-motion.mjs` (animation + geometry), `check-chat-regressions.mjs` (end-to-end chat),
`check-all-forms.mjs` (9 forms), `check-sandbox.mjs`, `check-commands.mjs` (slash-command list,
both locales), `check-help.mjs` (every help document, leaked i18n keys).

## Symptom → cause → fix

**`bad option --experimental-strip-types`** — Node < 22.6 (`.nvmrc` = 22). The only hard blocker.

**Panel opens, everything zero** — wrong config dir. `/api/location` → `source` names the rule that
picked it. Order in `claude-paths.ts`, first match wins: `manual` (Settings → config dir,
remembered) → `env` (`CLAUDE_CONFIG_DIR`) → `home` (`~/.claude`). A once-set manual path beats the
env var — if the user changed it and forgot, that's the answer.

**Sandbox says `Not logged in` while normal chat works** — most common on macOS, not an account
problem: the sandbox runs Claude with a substituted `CLAUDE_CONFIG_DIR`, so access must be carried
over separately. Windows/Linux keep it in `~/.claude/.credentials.json`; macOS has no such file
(keychain). Chain in `lib/credentials.ts`, first hit wins: `~/.claude-control/credentials.json`
(manual, beats all) → `<config>/.credentials.json` → macOS keychain → `ANTHROPIC_API_KEY`. Fix:
`pnpm doctor` "Доступ" line → on macOS accept the keychain dialog with "Always Allow" (renamed
entry → `CLAUDE_CONTROL_KEYCHAIN_SERVICE`) → universal route is Settings → Claude Code access → set
manually (`claudeAiOauth` | `apiKey` | `readFrom`), validated on the spot.

**`claude not found`** — panel spawns `claude.cmd` on Windows, `claude` elsewhere; must be in the
PATH of the process that started the server.

**MCP server won't connect** — on Windows `npx` needs a shell (`mcp.ts`, `McpProbe.ts`); args with
spaces are escaped via `shellArgs` (`cli-args.ts`), else `C:\Program Files\…` splits in two.

**403 on requests** — origin allowlist + `Sec-Fetch-Site` (`index.ts`); only `localhost:WEB_PORT`
and `127.0.0.1:WEB_PORT`. Changed the front port → set `WEB_PORT` for the server too.

**`127.0.0.1:8888` dead but `localhost:8888` works** — Vite binds `127.0.0.1` explicitly
(`vite.config.ts`). Reverse case = `localhost` resolves to `::1`.

## Working rules

- Verify by running, not by reasoning — `tools/qa/` drives the real UI per area.
- Never repeat failed logins (brute-force lockouts).
- Help is part of the code: sections `pages/Help/topics/*.tsx`, texts
  `shared/config/i18n/help/{ru,en}.ts`. Change a section's behaviour → change its help document
  (the user reads help inside the panel; drift here beats a stale README in damage). New document =
  entry in `HELP_GROUPS` + component beside it; index, `?topic=`, "?" button and next-section link
  follow automatically.
- `en.ts` is typed against `ru.ts` — a missing key fails the build; edit both in one pass.

Gate before "done": `pnpm type-check && pnpm lint && pnpm test && node tools/qa/audit-layout.mjs`.
Touched help → also `node tools/qa/check-help.mjs`: it opens every document from the `HELP_GROUPS`
registry looking for on-page `help.…` strings, i.e. a key called under a name that doesn't exist
(`tsc` checks dictionary completeness, not call sites).

## Where things live

**Server** `apps/server/src/` — config-dir discovery `lib/claude-paths.ts` · account access & OS
differences `lib/credentials.ts` · CLI arg escaping `lib/cli-args.ts` · safe write with backup
`lib/safe-io.ts` · backups/rollback `domains/backups.ts` · pricing fetch+cache
`domains/analytics/pricing-source.ts` · rates & per-model match `domains/analytics/pricing.ts` ·
enable/disable on disk `domains/entity-toggle.ts` · MCP client (stdio/HTTP/SSE)
`domains/mcp-client.ts` · MCP OAuth `domains/mcp-oauth.ts` · local-settings flag
`lib/settings-source.ts` · spawn `claude` + stream parsing `domains/chat/ChatRunner.ts` ·
transcripts `domains/chat/ChatHistory.ts` · conversation workdir `domains/chat/ChatWorkspace.ts` ·
project list `domains/chat/ChatProjects.ts` · disk browse & open-in-editor `domains/fs/` · sandbox
assembly `domains/sandbox/SandboxConfig.ts` · provider catalog & capabilities `providers/` ·
foreign-format check vs published schemas `domains/format-check.ts` · slash-command inventory
(skills + `commands/` + plugins, read-only) `domains/commands.ts` · opencode session server
`domains/opencode-serve.ts` · routes `routes/*.ts`.

**Web** `apps/web/src/`, FSD layers `app` → `pages` → `features` → `entities` → `shared` — UI kit
`shared/ui/` (each component has `*.stories.tsx`) · parallel agent runs `shared/lib/agent-runs/` ·
project tabs `shared/lib/workspace/` · sticky chat prefs `shared/lib/chat-prefs/` · motion
`shared/lib/motion/` · showcase data `shared/lib/mocks/` · dictionaries `shared/config/i18n/` ·
help texts `shared/config/i18n/help/` · help documents `pages/Help/topics/` + registry
`pages/Help/model/topics.ts` · built-in slash-command catalog (hand-maintained, ru+en)
`entities/Command/model/builtinCommands.ts` · diagrams `shared/ui/diagram/`.

Storybook: `pnpm --filter @claude-control/web storybook` (120 stories, 30 doc pages); port 6006
often taken → `-p 6019`.

## Deliberately absent

Own database (source of truth is Claude Code's files) · own login (the CLI authenticates) ·
serving the built front from the server (`pnpm start` = API only; dev front lives on Vite,
production must serve `dist` separately).
