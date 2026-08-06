# claude-control — agent map

Auto-loaded every session → tight and English. Humans read [docs/SETUP.ru.md](docs/SETUP.ru.md);
answers to the user stay Russian.

**Read on demand** (working notes, kept out of git — absent in a fresh clone):
[.claude/gotchas.md](.claude/gotchas.md) — traps already paid for; read the
entry BEFORE touching pricing/analytics, enable-disable of hooks/rules/groups, sessions & chat
resume, MCP OAuth, secrets, help texts, Windows file ops ·
[.agent/universal-providers.agent.md](.agent/universal-providers.agent.md) — capability map +
IMMUTABLE RULES, before any provider-layer edit ·
[.agent/provider-formats.agent.md](.agent/provider-formats.agent.md) — per-CLI facts, the ONE entry
you touch · [.agent/provider-tools.agent.md](.agent/provider-tools.agent.md) — model catalog,
environment transfer, format check vs published schemas.

**"Doesn't start" / "doesn't work on my system" → start at Triage, not at the code.**

## What it is

Local web panel over Claude Code's own configuration: reads and edits `~/.claude` (rules, skills,
hooks, permissions, MCP, env), transcript analytics, full CLI chat, isolated sandbox. Nine more
CLIs (codex/gemini/qwen/continue/goose/kimi/cursor/opencode/aider) are configurable; Claude is the
default and the only verified one. No database — **source of truth = Claude Code's files**.

- `apps/server` — Fastify :5178, reads/writes `~/.claude`, spawns `claude`
- `apps/web` — React + Vite :8888, proxies `/api`
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
the user's real config, not test data (reading is free, hand-editing goes through the panel's API).

QA runs live in `tools/qa/` and need `pnpm dev` up + `pnpm qa:setup`; each drives the real UI of one
area. Two behave unlike the rest: `check-attention.mjs` and `check-provider-chat.mjs` stub their
API, so they depend on no particular history and on no installed CLI.

## Symptom → cause → fix

**`bad option --experimental-strip-types`** — Node < 22.6 (`.nvmrc` = 22). The only hard blocker.

**Panel opens, everything zero** — wrong config dir. `/api/location` → `source` names the rule that
picked it. Order in `claude-paths.ts`, first match wins: `manual` (Settings → config dir,
remembered) → `env` (`CLAUDE_CONFIG_DIR`) → `home` (`~/.claude`). A once-set manual path beats the
env var — if the user changed it and forgot, that's the answer.

**Sandbox says `Not logged in` while normal chat works** — usually macOS, not an account problem:
the sandbox substitutes `CLAUDE_CONFIG_DIR`, so access is carried separately. Windows/Linux keep it
in `~/.claude/.credentials.json`; macOS has no such file (keychain). Chain in `lib/credentials.ts`,
first hit wins: `~/.claude-control/credentials.json` (manual, beats all) →
`<config>/.credentials.json` → macOS keychain → `ANTHROPIC_API_KEY`. Fix: read the access line of
`pnpm doctor` → on macOS accept the keychain dialog with "Always Allow" (renamed entry →
`CLAUDE_CONTROL_KEYCHAIN_SERVICE`) → universal route is Settings → Claude Code access, set manually
(`claudeAiOauth` | `apiKey` | `readFrom`).

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
- Help is part of the code: documents `pages/Help/topics/*.tsx`, texts
  `shared/config/i18n/help/{ru,en}.ts`. Change a section's behaviour → change its help document —
  the user reads help inside the panel, drift here beats a stale README in damage. New document =
  entry in `HELP_GROUPS` + component beside it; index, `?topic=`, "?" button and next-section link
  follow automatically.
- `en.ts` is typed against `ru.ts` — a missing key fails the build; edit both in one pass.

Gate before "done": `pnpm type-check && pnpm lint && pnpm test && pnpm depcruise && node
tools/qa/audit-layout.mjs`. Touched help → also `node tools/qa/check-help.mjs`: it looks for on-page
`help.…` strings, i.e. a key called under a name that doesn't exist (`tsc` checks the dictionary, not
call sites).

## Layer boundaries — checked, not just described

Both apps' layer maps are machine-enforced by `.dependency-cruiser.cjs` (`pnpm depcruise`), NOT by
ESLint — only dependency-cruiser has a path resolver (`tsconfig.depcruise.json`) and can tell an
import into a foreign slice from a sibling file of one's own folder. `eslint.config.mjs` keeps only
what needs no resolver (no default exports, no nested ternaries, `max-lines` 400 as a warning).

- **Web**: `app → pages → features → entities → shared`, downward only, cross-feature forbidden
  (one exception, `features/ResourceFiles`, documented in the config); a foreign slice is reachable
  only through its `index.ts`.
- **Server**: `context → routes → domains → providers → lib → contracts`, downward only. A domain
  takes primitives (`paths`, `store`, `backupDir`), never `ServerContext`. `lib/` is format and OS
  helpers with no knowledge of the registry — anything that needs the provider registry lives in
  `providers/`. Tests are exempt: a test may reach into any layer.
- Oversized module split idiom: `foo.ts` becomes a thin facade re-exporting a `foo/` folder of
  cohesive modules, so every existing import path (and every test) keeps working.

## Where things live

Only what a name does not give away — the rest is one `Grep` from here.

**Server** `apps/server/src/` — config dir `lib/claude-paths.ts` · account access & OS differences
`lib/credentials.ts` · CLI arg escaping `lib/cli-args.ts` · process spawn, both chat branches
`lib/cli-spawn.ts` · safe write `lib/safe-io.ts` · path-containment guard shared by
rules/skills/plugins `lib/section-fs.ts` · "foreign format not recognised" sentinel
`lib/format-errors.ts` · provider catalog, CLI detect, settings validation `providers/` · pricing
`domains/analytics/` · enable/disable on disk `domains/entity-toggle.ts` · Claude chat (spawn,
stream, transcripts, SSE, cost) `domains/chat/` · chat of a FOREIGN provider — panel-owned JSONL,
prompt rebuild, streamed stdout — `domains/provider-chat/`, which never touches the Claude branch:
that separation is the regress guarantee. DLP proxy between a CLI and the model (127.0.0.1 only, no
TLS interception, fail-closed on an unparsed body) `domains/dlp/`; the `UserPromptSubmit` gate built
on the same rules — block/warn only, the event cannot rewrite a prompt — `domains/prompt-gate/` —
read `.agent/provider-tools.agent.md` before touching either. Per-section provider domains
(`provider-{mcp,permissions,rules,skills,plugins,hooks,…}`) follow the facade+folder idiom.

**Web** `apps/web/src/`, FSD layers `app` → `pages` → `features` → `entities` → `shared` — UI kit
`shared/ui/` (each component has `*.stories.tsx`) · browser badge & dots `shared/lib/attention/` ·
foreign-provider chat `pages/ProviderChat/` + `entities/ProviderChat/` (routed from
`pages/Chat/ChatSection.tsx`) · dictionaries `shared/config/i18n/` · help texts
`shared/config/i18n/help/` · help documents `pages/Help/topics/` + registry
`pages/Help/model/topics.ts` · built-in slash-command catalog (hand-maintained, ru+en)
`entities/Command/model/builtinCommands.ts`.

Storybook: `pnpm --filter @claude-control/web storybook` (120 stories, 30 doc pages); port 6006
often taken → `-p 6019`.

## Deliberately absent

Own database (source of truth is Claude Code's files) · own login (the CLI authenticates) ·
serving the built front from the server (`pnpm start` = API only; dev front lives on Vite,
production must serve `dist` separately).

**Stays a local single-user app — decided 2026-08-06, do not re-litigate.** Not a hosted service:
the truth is the files on THIS machine, access comes from the CLI's own login, and exposing the
panel would first require inventing auth, tenants and isolation that nothing here needs. Remote
access = SSH tunnel, not a deploy. Electron was weighed and dropped too: it fixes nothing (the user
still installs and logs into the CLI himself) and adds code signing, ~180 MB and an update channel.
If shipping to another person ever comes up, the answer is an `npx` wrapper that boots the server
and opens the browser — not a package format.
