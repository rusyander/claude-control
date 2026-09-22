# agentdeck — agent map

Auto-loaded every session → tight and English. Humans read [docs/SETUP.ru.md](docs/SETUP.ru.md) and
[docs/TROUBLESHOOTING.ru.md](docs/TROUBLESHOOTING.ru.md);
answers to the user stay Russian.

**Read on demand** (working notes, kept out of git — absent in a fresh clone):
[.agent/code-map.agent.md](.agent/code-map.agent.md) — which module owns what, per app; read it
before touching code you have not touched this session; chat at a foreign CLI has its own map,
[.agent/code-map-foreign-chat.agent.md](.agent/code-map-foreign-chat.agent.md) ·
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
  the pnpm workspace); `pnpm mobile`, `pnpm mobile:type-check`, `pnpm mobile:test`, `pnpm mobile:apk` (release APK to
  the repo root, gitignored, replaces the previous one), `pnpm mobile:clean`. Expo's API moves
  between SDKs — check https://docs.expo.dev/versions/v57.0.0/ before writing native code
- `packages/contracts` — shared types + zod schemas
- `tools/` — `doctor.mjs` (environment check), `qa/*.mjs` (Playwright runs), `tailscale-serve.mjs`
  (`pnpm remote` / `off`), `keepalive.mjs` (`pnpm keepalive[:install|:off|:status]` — watchdog over
  both dev halves, see the entry below), `build-mobile-apk.mjs`, `clean-mobile-build.mjs` (Gradle hides native
  intermediates in `node_modules/*/android/{build,.cxx}` — ~10 GB per release build, in neither APK
  nor repo; the build sweeps them itself, `--keep-build` opts out, `--dry` measures),
  `make-mobile-icons.mjs` (one SVG mark → every icon/splash size, so launcher, splash and favicon
  cannot drift), `tests-cli.mjs` (`pnpm tests list|show|run|import|export|report|lint|diff|plan` —
  the QA workspace of a project without the panel; CI gates on the exit code: `report` 1 on a failure
  outside quarantine, `diff` 1 on NEW failures only, `lint` 1 only when asked via `--fail-on`),
  `docs/` — the human's PDF guides, two of them: `shots-chat-guide.mjs` (14 frames) and
  `shots-tests-guide.mjs` (30) shoot a fully stubbed panel, `build-guide.mjs` prints through
  Chromium and each `build-*-guide.mjs` is only its three values (source, out, footer) →
  `docs/CHAT-GUIDE.ru.pdf`, `docs/TESTS-GUIDE.ru.pdf`. Sources and frames live in
  `.agent/{chat,tests}-guide/`, OUT of git — git carries the finished PDFs only; a fresh clone
  re-shoots against a running stand. `PAGES=<dir>` also rasterises the print page by page — a PDF
  handed to the human is looked at page by page, never shipped unseen

Needs **Node 22.6+** (server runs with `--experimental-strip-types`), pnpm 10, `claude` in PATH.

## Triage in 60 seconds

```bash
pnpm doctor                                # node, claude in PATH, config dir, account access
                                           # (incl. macOS keychain), ports, deps — exit 1 = blocking
curl http://127.0.0.1:5178/api/location    # which dir, which rule chose it, what's missing
curl http://127.0.0.1:5178/api/system      # platform, home, shell
curl http://127.0.0.1:5178/api/credentials # access source (token is NEVER returned)
```

`{"error":"Нужен токен доступа"}` (401) on all four is not a fault: the remote gate is on, and these
need `-H "Authorization: Bearer $(cat ~/.agentdeck/api-token)"`. The browser is exempt — it passes
the origin allowlist instead.

`/api/location` answers most questions on its own. No match in the symptom files → narrow: server vs front (`curl`
the API), panel vs CLI (`claude --version` in the terminal that started the server). Fixed →
**verify by running**, then report what was verified and what stayed unverified.

Fix without asking: project code, deps, build config, launch env. Ask first: files in `~/.claude` —
the user's real config, not test data (reading is free, hand-editing goes through the panel's API).

QA runs live in `tools/qa/` and need `pnpm dev` up + `pnpm qa:setup`; each drives the real UI of one
area. A third of them behave unlike the rest — every `check-tests-*` bar `check-tests-exchange.mjs`
and `check-tests-baselines.mjs`, plus the newer chat/project ones, stub their own API
(`grep -l page.route tools/qa` names them; a list here would go stale within a batch), and
`check-worktrees.mjs` builds its own git repository in temp,
so they depend on no particular history, on no installed CLI, and leave neither branches nor copies
behind. `panel-pages.mjs` is the ONE route list the a11y (axe, both themes, create modals) and
keyboard (Tab order, focus ring, Escape + focus return) sweeps share — a new section goes there or
neither audit ever sees it.

## Symptom → cause → fix

Moved to `.agent/` 2026-09-22 — one file per area, 34 entries. Grep the symptom text across them;
a new entry goes into the area file, never back here.

- **boot** [agents-symptoms-boot.agent.md](.agent/agents-symptoms-boot.agent.md) — `--experimental-strip-types`, contracts barrel at runtime, APK bundle, post-rename settings, wrong config dir
- **cli** [agents-symptoms-cli.agent.md](.agent/agents-symptoms-cli.agent.md) — `claude not found`, sandbox `Not logged in`, MCP will not connect, Jira/Confluence «не подключена»
- **transport** [agents-symptoms-transport.agent.md](.agent/agents-symptoms-transport.agent.md) — 403 origin, `127.0.0.1` vs `localhost`, stale snapshot until F5, panel asleep after idle hours
- **chat** [agents-symptoms-chat.agent.md](.agent/agents-symptoms-chat.agent.md) — permission refused «Панель перезапускалась», new chat, group switched itself on, initiative misfire, «/clear» written in words, «Картинка» locked
- **copies** [agents-symptoms-copies.agent.md](.agent/agents-symptoms-copies.agent.md) — red task tabs + longpaths, missing `.mcp.json`, «установка не удалась», split with one chat, branch overlaps, 409 on removal
- **tests** [agents-symptoms-tests.agent.md](.agent/agents-symptoms-tests.agent.md) — empty history record, quarantined red case, coverage matrix shows only linked
- **contour** [agents-symptoms-contour.agent.md](.agent/agents-symptoms-contour.agent.md) — refusal after reboot, model-written call ignored, 403 «модель»
- **portability** [agents-symptoms-portability.agent.md](.agent/agents-symptoms-portability.agent.md) — environment transferred, hook does not fire

## Working rules

- Verify by running, not by reasoning — `tools/qa/` drives the real UI per area.
- Never repeat failed logins (brute-force lockouts).
- Help is part of the code: documents `pages/Help/topics/*.tsx`, texts
  `shared/config/i18n/help/{ru,en}/topics/<topic>.ts` (one module per topic, carrying that topic's
  shot and diagram captions too; `{ru,en}.ts` are only the composers, and `en` stays typed against
  `ru` per topic). Change a section's behaviour → change its help document —
  the user reads help inside the panel, drift here beats a stale README in damage. New document =
  entry in `HELP_GROUPS` + component beside it; index, `?topic=`, "?" button and next-section link
  follow automatically.
- **That "change its help document" is GATED, not remembered.** `apps/web/public/help/sources.json`
  holds, per topic, the modules whose BEHAVIOUR the document describes + a content fingerprint of each
  (EOL and comment-only lines ignored — a rule reddening on every refactor gets ignored). One of them
  moves ⇒ `pnpm shots` RED, naming topic, files and command. Clearing it is a human act: re-read the
  document, fix the text, then `node tools/help-shots/sources.mjs <topic>` (rewrites the fingerprints;
  nothing auto-heals). Seeded with `platform` only — an unwatched topic never reddens and the guard
  prints how many are watched. **Adding a topic = ONE entry** (topic id from `HELP_GROUPS`, document
  path, narrow `path`+`why` list, empty `sha`) then that command. Narrow = the modules carrying what
  the human reads about, never a whole tree.
- `en.ts` is typed against `ru.ts` — a missing key fails the build; edit both in one pass.

Gate before "done": `pnpm type-check && pnpm lint && pnpm test && pnpm depcruise && pnpm compromises
&& pnpm negatives && pnpm shots && pnpm brand && pnpm mobile:contracts && node tools/qa/audit-layout.mjs && node tools/qa/check-a11y.mjs && node tools/qa/check-keyboard.mjs && node
tools/qa/check-etag.mjs` (the last four drive the live stand; `check-etag` reads the wire status through CDP,
because Playwright reports a 304 revalidation as the cached 200). `pnpm test` measures coverage every run and fails below the thresholds
pinned in each `vitest.config.ts` (raise them when coverage grows, never lower silently). The same
gate runs unattended: pre-commit (husky + lint-staged: eslint, prettier check, LF check —
`tools/check-lf.mjs`) and `.github/workflows/ci.yml` (format:check → type-check → lint → test →
depcruise, plus mobile type-check + tests). Touched help → also `node tools/qa/check-help.mjs`: it looks for on-page
`help.…` strings, i.e. a key called under a name that doesn't exist (`tsc` checks the dictionary, not
call sites). Touched the contour (`domains/platform/**`) → also `node tools/qa/check-platform-wire.mjs`:
it boots its own throwaway panel plus `tools/qa/stub-platform.mjs` as the upstream and drives the whole
socket path client → gateway → contour, so it needs no stand and no installed CLI — **and `node
tools/qa/check-platform-run-env.mjs`**, which is the only check that sees what reaches a real process:
its own throwaway panel, a gateway on port 0 and fake CLIs on PATH that dump their own env and argv.
Touched our layers (`domains/platform/layers.ts`, the run registry's flags) → **`node
tools/qa/check-run-layers.mjs`**, the only check that answers what a launch flag actually REMOVES:
the real `claude` with a throwaway config dir carrying a unique marker in every layer, a stub for the
model, and the body of the request that went up as the sole evidence. It needs an installed CLI
(`CLAUDE_CLI` overrides the path) and touches no stand of the user's.
Touched images (`domains/media/**`, the composer's mode menu, the gateway's content parts) → **`node
tools/qa/check-chat-media.mjs`**, whose evidence is the FILE on disk: its own throwaway panel and stub
upstream, 18 assertions, and the drawn bytes compared to what the upstream returned — plus `state.json`
and the request trace searched for base64, because "no image in the settings" cannot be proved by
reading code. No stand, no installed CLI.
Everything else about the contour is proved on frames built inside the test that reads them — green
there is compatible with nothing passing over a real wire.

## Layer boundaries — checked, not just described

Both apps' layer maps are machine-enforced by `.dependency-cruiser.cjs` (`pnpm depcruise`), NOT by
ESLint — only dependency-cruiser has a path resolver (`tsconfig.depcruise.json`) and can tell an
import into a foreign slice from a sibling of one's own folder. `eslint.config.mjs` keeps only what
needs no resolver (no default exports, no nested ternaries, `max-lines` 400 as a warning).

- **Web**: `app → pages → features → entities → shared`, downward only, cross-feature forbidden
  (one exception, `features/ResourceFiles`, documented in the config); a foreign slice is reachable
  only through its `index.ts`.
- **Server**: `index/bootstrap/context → routes → domains → providers → lib → contracts`, downward
  only (`bootstrap/` = runtime, route table, banner — the assembly index.ts delegates to). A domain
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
