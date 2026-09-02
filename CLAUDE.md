# claude-control — agent map

Auto-loaded every session → tight and English. Humans read [docs/SETUP.ru.md](docs/SETUP.ru.md);
answers to the user stay Russian.

**Read on demand** (working notes, kept out of git — absent in a fresh clone):
[.agent/code-map.agent.md](.agent/code-map.agent.md) — which module owns what, per app; read it
before touching code you have not touched this session ·
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
- `apps/mobile` — Expo (SDK 57 / RN 0.86) phone app over the same API, own toolchain (`npm`, not
  the pnpm workspace); `pnpm mobile`, `pnpm mobile:type-check`, `pnpm mobile:apk` (release APK to
  the repo root, gitignored, replaces the previous one), `pnpm mobile:clean`. Expo's API moves
  between SDKs — check https://docs.expo.dev/versions/v57.0.0/ before writing native code
- `packages/contracts` — shared types + zod schemas
- `tools/` — `doctor.mjs` (environment check), `qa/*.mjs` (Playwright runs), `tailscale-serve.mjs`
  (`pnpm remote` / `off`), `keepalive.mjs` (`pnpm keepalive[:install|:off|:status]` — watchdog over
  both dev halves, see the entry below), `build-mobile-apk.mjs`, `clean-mobile-build.mjs` (Gradle hides native
  intermediates in `node_modules/*/android/{build,.cxx}` — ~10 GB per release build, in neither APK
  nor repo; the build sweeps them itself, `--keep-build` opts out, `--dry` measures),
  `make-mobile-icons.mjs` (one SVG mark → every icon/splash size, so launcher, splash and favicon
  cannot drift)

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
area. Eight behave unlike the rest — `check-attention.mjs`, `check-provider-chat.mjs`,
`check-project-code.mjs`, `check-task-split.mjs`, `check-handoff.mjs`, `check-parent-hub.mjs`,
`check-new-chat.mjs` stub their API and `check-worktrees.mjs` builds its own git repository in temp,
so they depend on no particular history, on no installed CLI, and leave neither branches nor copies
behind.

## Symptom → cause → fix

**`bad option --experimental-strip-types`** — Node < 22.6 (`.nvmrc` = 22). The only hard blocker.

**Panel opens, everything zero** — wrong config dir. `/api/location` → `source` names the rule that
picked it. Order in `claude-paths.ts`, first match wins: `manual` (Settings → config dir,
remembered) → `env` (`CLAUDE_CONFIG_DIR`) → `home` (`~/.claude`). A once-set manual path beats the
env var — if the user changed it and forgot, that's the answer.

**Sandbox says `Not logged in` while normal chat works** — usually macOS, not an account problem:
the sandbox substitutes `CLAUDE_CONFIG_DIR`, so access is carried separately, and macOS has no
`.credentials.json` at all (keychain). Chain in `lib/credentials.ts`, first hit wins:
`~/.claude-control/credentials.json` (manual, beats all) → `<config>/.credentials.json` → macOS
keychain → `ANTHROPIC_API_KEY`. Fix: read the access line of `pnpm doctor` → on macOS accept the
keychain dialog with "Always Allow" (renamed entry → `CLAUDE_CONTROL_KEYCHAIN_SERVICE`) →
universal route is Settings → Claude Code access (`claudeAiOauth` | `apiKey` | `readFrom`).

**`claude not found`** — panel spawns `claude.cmd` on Windows, `claude` elsewhere; must be in the
PATH of the process that started the server.

**MCP server won't connect** — on Windows `npx` needs a shell (`mcp.ts`, `McpProbe.ts`); args with
spaces are escaped via `shellArgs` (`cli-args.ts`), else `C:\Program Files\…` splits in two.

**403 on requests** — origin allowlist + `Sec-Fetch-Site` (`index.ts`); only `localhost:WEB_PORT`
and `127.0.0.1:WEB_PORT`. Changed the front port → set `WEB_PORT` for the server too.

**`127.0.0.1:8888` dead but `localhost:8888` works** — Vite binds `127.0.0.1` explicitly
(`vite.config.ts`). Reverse case = `localhost` resolves to `::1`.

**Panel stays on a stale snapshot until F5** (a chat started elsewhere never shows up, an answer
stops growing) — liveness has two independent legs, check both: `/api/events` must emit `: ping`
every 25 s (`index.ts` — an idle SSE socket dies silently and `EventSource` never notices without
a break it can see), and `FileWatchProvider` must reconnect on `visibilitychange`/`online`,
invalidating everything on any non-first `onopen`. A run started OUTSIDE this window is adopted by
polling `/chat/active` (`pages/Chat/model/useRunLifecycle.ts`), not by one shot on mount. Proof is
`node tools/qa/check-live-sync.mjs`: it fires a run straight into the API, like the phone does, and
never reloads the page.

**"New chat" seems not to fire — the previous conversation stays on screen** — the click DID work:
title, list selection and the URL all change. What does not change is the only thing the human looks
at, the thread. `useChatMessages` (`entities/Chat/api/ChatApi.ts`) keeps the previous window through
`placeholderData: keepPreviousData` — right while `limit` grows for "load more", wrong the moment the
conversation is dropped for a draft and `chatId` empties, because react-query then serves the old
query's data under the new key. Keep it conditional on `chatId`. Guard: `node
tools/qa/check-new-chat.mjs`, both the project tab and the home one.

**A group switched itself on and nobody touched the toggle** — by design. A group bound to project
paths is ENABLED when a run starts in one of them (`domains/group-activation.ts`, called from
`routes/chat/run-routes.ts`), a parallel copy `<repo>-worktrees/<branch>` included. It never disables
anything, so nothing the user turned on is taken away; drop the path on the Groups page to stop it.

**The agent answers something adjacent, or an initiative "never fires" (Windows)** — check what the
CLI actually received before touching prompts. Text with quotes in argv is destroyed by
`cmd.exe` → `claude.cmd` → `claude.exe`: `--append-system-prompt` was truncated and a fragment became
a POSITIONAL argument, i.e. the prompt (`"контекст\n<what the human sent>"`, every message). Long text
goes through a file (`--append-system-prompt-file`, `ChatRunner.run`), never argv; a fake `.cmd` over
node parses it fine, so only a REAL run proves it. Detail + probe: `.claude/gotchas.md` §Sessions.

**Task tabs all turn red; the agent inside a copy offers to "fix longpaths and restore"** — Windows
260-char limit. Copies live at `<repo>-worktrees/<branch>/…`, longer than the original, and git
without long paths reports real files as ` D` (`could not open directory … Filename too long`) — an
agent's `git add -A` there would commit those deletions. The panel writes `core.longpaths` into the
repository's own config on `worktree add` (`domains/project-git/worktrees.ts → ensureLongPaths`;
`--local`, because a bare `--get` answers `true` through the panel's own `-c`). Machine-wide is the
user's: `git config --global core.longpaths true` plus `git worktree prune`; `pnpm doctor` checks
that key AND `LongPathsEnabled` in the registry. Reproduce end-to-end with
`.agent/tmp/live-longpaths.mjs` — it neutralises the global config via `GIT_CONFIG_GLOBAL`, because
on a machine where either switch is already on the failure cannot be shown at all. **Capture stderr
when probing this**: git emits the warning and still exits 0, so a stdout-only check reads as "no
problem".

**A parallel working copy refuses to be removed (409)** — an agent is running inside it. That is why
`routes/project-git-routes.ts` takes the run registry as its third argument, and the check holds for
the phone too. Copies live NEXT to the repo (`<parent>/<repo>-worktrees/<branch>`, never inside —
watchers and bundlers would recurse), and the panel never merges anything: merging stays with the
user.

**Panel "switched itself off" after a few idle hours; sometimes only one half** — nothing in the
panel crashed. The machine's own janitor (`~/.claude/tools/proc-reaper`, scheduled task `ProcReaper`,
every 4 h) reaped the stand: `pnpm dev` grows from a shell that has long exited, so the whole tree
reads as orphaned, and the reaper spared only the two PIDs holding a socket — the `pnpm` / `cmd` /
`node --watch` above them died, which is exactly why one half kept serving and the other vanished.
Fixed 2026-09-01 on both sides. Janitor: `ProtectPorts` (5178/8888 — listener, its subtree AND its
ancestor chain, no age cap) plus ancestor immunity for every young listener, so no stand is
decapitated again. Repo: `pnpm keepalive:install` — TCP-probes both ports every 20 s, restarts the
silent half, adopts a stand that is already up instead of fighting it for the port. Autostart is
user-level (Startup folder + a 5-minute pickup task; `/sc ONLOGON` needs admin and is not used).
Log `%LOCALAPPDATA%\claude-control\keepalive.log`, state `pnpm keepalive:status`. The probe is a TCP
connect, never HTTP: with the remote token gate on, a live panel answers 401.

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
import into a foreign slice from a sibling of one's own folder. `eslint.config.mjs` keeps only what
needs no resolver (no default exports, no nested ternaries, `max-lines` 400 as a warning).

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

Roots: `apps/server/src/` (Fastify) · `apps/web/src/` (React, FSD) · `apps/mobile/`
(Expo) · `packages/contracts/` · `tools/`. Everything else — which module owns which behaviour, and
the traps around it — is [.agent/code-map.agent.md](.agent/code-map.agent.md), read on demand
before touching code. Keep it current in the same pass as the code; it is the map, not a changelog.

## Deliberately absent

Own database (source of truth is Claude Code's files) · own login (the CLI authenticates) ·
serving the built front from the server (`pnpm start` = API only; dev front lives on Vite,
production must serve `dist` separately).

**Stays a local single-user app — decided 2026-08-06, do not re-litigate.** The truth is the files
on THIS machine and access comes from the CLI's own login, so hosting it would first mean inventing
auth, tenants and isolation nothing here needs. Remote (2026-08-09) does not change that: loopback
bind, Tailscale Serve terminating on this machine, the phone as the SAME user with one opt-in
Bearer token. Electron was weighed and dropped (fixes nothing, costs signing + ~180 MB + an update
channel); shipping to another person would be an `npx` wrapper booting the server.
