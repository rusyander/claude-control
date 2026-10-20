# agentdeck — agent map

Auto-loaded every session → tight and English. Humans read [docs/SETUP.ru.md](docs/SETUP.ru.md) and
[docs/TROUBLESHOOTING.ru.md](docs/TROUBLESHOOTING.ru.md);
answers to the user stay Russian.

**Read on demand** (working notes, kept out of git — absent in a fresh clone):
[.agent/code-map.agent.md](.agent/code-map.agent.md) — which module owns what, per app; read it
before touching code you have not touched this session; chat at a foreign CLI has its own map,
[.agent/code-map-foreign-chat.agent.md](.agent/code-map-foreign-chat.agent.md) ·
[.claude/gotchas.md](.claude/gotchas.md) — traps already paid for (sessions & chat resume →
[gotchas-sessions.md](.claude/gotchas-sessions.md), enable-disable of hooks/rules/groups →
[gotchas-enable-disable.md](.claude/gotchas-enable-disable.md)); read the entry BEFORE touching pricing/analytics, MCP OAuth, secrets, help texts, Windows file ops ·
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
  both dev halves), `build-mobile-apk.mjs`, `clean-mobile-build.mjs` (Gradle native intermediates in
  `node_modules/*/android/{build,.cxx}`, ~10 GB per release build; the build sweeps them, `--keep-build` opts
  out, `--dry` measures), `make-mobile-icons.mjs` (one SVG mark → every icon/splash size),
  `tests-cli.mjs` (`pnpm tests list|show|run|import|export|report|lint|diff|plan|case|record` — the QA workspace
  of a project without the panel; CI exit codes: `report` 1 on a failure outside quarantine, `diff` 1 on NEW
  failures only, `lint` 1 only with `--fail-on`), `docs/` — PDF guides: `shots-{chat,tests}-guide.mjs` shoot a
  fully stubbed panel, `build-guide.mjs` prints through Chromium (`build-*-guide.mjs` = source, out, footer) →
  `docs/{CHAT,TESTS}-GUIDE.ru.pdf`; sources and frames in `.agent/{chat,tests}-guide/`, OUT of git (a fresh
  clone re-shoots against a running stand). `PAGES=<dir>` rasterises page by page — every page is looked at
  before a PDF is handed over

Needs **Node 22.6+** (server runs with `--experimental-strip-types`), pnpm 10, `claude` in PATH.

## Triage in 60 seconds

```bash
pnpm doctor                                # node, claude in PATH, config dir, account access
                                           # (incl. macOS keychain), ports, deps — exit 1 = blocking
curl http://127.0.0.1:5178/api/location    # which dir, which rule chose it, what's missing
curl http://127.0.0.1:5178/api/system      # platform, home, shell
curl http://127.0.0.1:5178/api/credentials # access source (token is NEVER returned)
```

401 `{"error":"Нужен токен доступа"}` = remote gate on, not a fault: add
`-H "Authorization: Bearer $(cat ~/.agentdeck/api-token)"` (the browser passes the origin allowlist instead).

No match in the symptom files → narrow: server vs front (`curl` the API), panel vs CLI (`claude --version` in
the terminal that started the server). Fixed → **verify by running**; report verified and unverified.

Fix without asking: project code, deps, build config, launch env. Ask first: files in `~/.claude` —
the user's real config, not test data (reading is free, hand-editing goes through the panel's API).

QA runs live in `tools/qa/` and need `pnpm dev` up + `pnpm qa:setup`; each drives the real UI of one
area. About a third stub their own API (`grep -l page.route tools/qa` names them) and `check-worktrees.mjs`
builds its own git repo in temp — those need no history, no installed CLI and leave nothing behind.
`panel-pages.mjs` is the ONE route list the a11y (axe, both themes, create modals) and keyboard (Tab order,
focus ring, Escape + focus return) sweeps share — a new section goes there or neither audit sees it.

## Symptom → cause → fix

Moved to `.agent/` 2026-09-22, one file per area. Grep the symptom text across them;
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
  `shared/config/i18n/help/{ru,en}/topics/<topic>.ts` (one module per topic incl. shot and diagram captions;
  `{ru,en}.ts` only compose, `en` typed against `ru` per topic). Change a section's behaviour → change its
  help document (the user reads help in the panel; drift there hurts more than a stale README). New
  document = entry in `HELP_GROUPS` + component beside it; index, `?topic=`, "?" and next-link follow.
- **That "change its help document" is GATED, not remembered.** `apps/web/public/help/sources.json`
  holds, per topic, the modules whose BEHAVIOUR the document describes + a content fingerprint of each
  (EOL and comment-only lines ignored). One moves ⇒ `pnpm shots` RED, naming topic, files and command.
  Clearing it: re-read the document, fix the text, then `node tools/help-shots/sources.mjs <topic>`
  (rewrites the fingerprints; nothing auto-heals). 32 topics watched (20.10); an unwatched topic never
  reddens. **Adding a topic = ONE entry** (topic id from `HELP_GROUPS`, document path, narrow `path`+`why`
  list, empty `sha`) then that command — narrow = the modules carrying what the human reads, never a tree.
- `en.ts` is typed against `ru.ts` — a missing key fails the build; edit both in one pass.
- **Changelog travels with the change** (owner 12.10.2026). Tab «Что нового» (default tab of `/history`) = curated
  `changelog/entries/<YYYY-MM-DD>-<slug>.json` (one per push/MR) + git facts; commits without an entry show
  from their message. A commit/push with a user-visible change (feature, fix, behaviour, UI, help) adds or
  updates its entry IN THE SAME commit, never a follow-up; later commits of the same push/MR update that
  entry (every commit touching the file binds to it). Pure internal work (refactor, tests, agent docs, CI)
  needs none — keep its commit message readable, the page shows it as is. Draft `pnpm changelog:new`, then
  rewrite: title = outcome; items by kind added/improved/fixed/changed/removed/docs/internal; `how` only where
  the approach matters to a reader; a visible fix carries its before/after pair in `changelog/assets/<id>/`
  (≤400 KB, stubbed data only — public repo). Text = published text: Russian, impersonal, what + why, no
  authorship, no process narration, no company/contour names, no local paths. Format change → contracts
  schema + this rule + help topic `history` in one pass. Map: `code-map.agent.md` / `code-map-web.agent.md`,
  spec `.agent/changelog-page-plan.agent.md`. Uncommitted numbers live only on the «Незакоммиченные правки»
  card. `pnpm changelog:remind` runs in pre-commit (warns, never blocks).

Gate before "done": `pnpm type-check && pnpm lint && pnpm test && pnpm depcruise && pnpm compromises
&& pnpm negatives && pnpm shots && pnpm brand && pnpm mobile:contracts && node tools/qa/audit-layout.mjs && node tools/qa/check-a11y.mjs && node tools/qa/check-keyboard.mjs && node
tools/qa/check-etag.mjs` (the last four drive the live stand; `check-etag` reads the wire status through CDP,
because Playwright reports a 304 revalidation as the cached 200). `pnpm test` measures coverage every run and fails below the thresholds
pinned in each `vitest.config.ts` (raise them when coverage grows, never lower silently). The same
gate runs unattended: pre-commit (husky + lint-staged: eslint, prettier check, LF + raw-NUL check —
`tools/check-lf.mjs`) and `.github/workflows/ci.yml` (format:check → type-check → lint → test →
depcruise, plus mobile type-check + tests). Area checks on top — each is the only one that sees its real path;
none needs the stand:

- help → `node tools/qa/check-help.mjs` (on-page `help.…` keys called under a missing name; `tsc` checks the
  dictionary, not call sites);
- contour `domains/platform/**` → `node tools/qa/check-platform-wire.mjs` (throwaway panel + `stub-platform.mjs`,
  whole socket path client → gateway → contour) **and** `check-platform-run-env.mjs` (fake CLIs on PATH dump the
  env and argv that reached a real process);
- our layers (`domains/platform/layers/layers.ts`, run registry flags) → `check-run-layers.mjs` (real `claude`,
  throwaway config dir with a marker per layer, stub model; the request body is the evidence of what a flag
  REMOVES; needs an installed CLI, `CLAUDE_CLI` overrides);
- images (`domains/media/**`, composer mode menu, gateway content parts) → `check-chat-media.mjs` (the file on
  disk vs the upstream bytes, `state.json` + request trace searched for base64).
  Every other contour test builds its frames inside itself — green there proves nothing about a real wire.

## Tests block — agentdeck tests itself through it

Owner 27.09.2026: the Tests block is the product, so agentdeck's own QA runs THROUGH it — a check
run beside it proves nothing about the block. Store: `.agent/tests/` (cases, groups, history).

- A case is linked by `automation={status:'automated', file, testName?}` (testName = the FULL vitest
  path from the outermost describe, "a > b > it"; a describe path covers every test under it). Run: `node tools/tests-cli.mjs run --project . [--group g]`;
  `tools/qa/junit-run.mjs` turns exit-code scripts and vitest into JUnit `[caseId]` testcases,
  `--health <url>` records a stand restart as skipped, never failed.
- A verdict on a case comes only from a run recorded in the block's history, not from a local run.
- A new QA script is linked to its case in the same pass that writes it.
- A red result is classified before it is reported: product defect, stale check, or stand down.
- Never link a script that writes real config (`~/.claude*`, the contour, transcripts): a linked
  case gets run unattended.

## Layer boundaries — checked, not just described

Both apps' layer maps are enforced by `.dependency-cruiser.cjs` (`pnpm depcruise`, path resolver
`tsconfig.depcruise.json`), NOT ESLint; `eslint.config.mjs` keeps only resolver-free rules (no default
exports, no nested ternaries, `max-lines` 400 as a warning).

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

**Stays a local single-user app — decided 2026-08-06, do not re-litigate.** The truth is the files on THIS
machine and access is the CLI's own login; hosting would mean inventing auth, tenants and isolation. Remote
(2026-08-09) keeps that: loopback bind, Tailscale Serve on this machine, the phone as the SAME user with one
opt-in Bearer token. Electron dropped (signing + ~180 MB + update channel, fixes nothing); shipping to another
person = an `npx` wrapper booting the server.
