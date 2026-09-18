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

`/api/location` answers most questions on its own. No match below → narrow: server vs front (`curl`
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

**`bad option --experimental-strip-types`** — Node < 22.6 (`.nvmrc` = 22). The only hard blocker.

**Server refuses to boot at all: `ERR_MODULE_NOT_FOUND … contracts/src/claude-location`** — nothing
is wrong with that file. `packages/contracts/src/index.ts` re-exports its neighbours WITHOUT
extensions, so the barrel is loadable by Vite and by tsc but never by the server, which runs under
`--experimental-strip-types`. The server therefore takes **only types** from `@agentdeck/contracts`;
one value imported from the barrel loads it at runtime and kills the whole process — and `node --watch`
plus `keepalive` then relive the crash every few seconds. Fix: import the value from the package's
subpath (`@agentdeck/contracts/<module>`), adding it to `exports` in
`packages/contracts/package.json` if it is not there yet. Guarded since 09.09.2026 by the
`server-contracts-barrel-types-only` rule in `.dependency-cruiser.cjs` — `pnpm depcruise` names the
offending edge, so this must never reach a running panel again.

**APK build dies at `createBundleReleaseJsAndAssets`: `Unable to resolve module @agentdeck/contracts/X`**
— the mobile twin of the entry above, and the nastier one: `pnpm mobile:type-check` and the mobile
tests stay GREEN on a tree whose APK no longer builds, because tsc resolves the subpath through the
package while Metro does not. Mobile lives outside the pnpm workspace with its own npm linkage, so a
contracts module needed AS A VALUE is resolved straight to source via `VALUE_MODULES` in
`apps/mobile/metro.config.js` — a hand-kept list. A module missing from it fails to resolve; a module
on it that (transitively, through non-type imports) reaches an outside package fails too, because
mobile's `node_modules` has no zod. Type-only imports are erased and never reach Metro, so they are
free. Fix: put the value in a module with no external imports (`packages/contracts/src/platform-layers.ts`
is the pattern — it re-exports from `platform.ts`, so every existing import keeps working), add it to
the package `exports` and to `VALUE_MODULES`. Guard `pnpm mobile:contracts`
(`tools/qa/check-mobile-contracts.mjs`, selftest included) — it reads the list out of the config
itself, skips test files (not in Metro's graph) and follows relative imports to find the outside one.

**Settings/token/keys "lost" after the rename, or the pre-rename product name reappears** — the product
had another name until 17.09.2026 (`LEGACY_BRAND_*` in `apps/server/src/lib/brand.mjs`). The old name is
NEVER written literally anywhere in the tree — it is built from parts (`LEGACY_PARTS`), tests spell it
reversed, the gate fixture holds a `%%PAST_BRAND_NAME%%` placeholder — because git history is rewritten by
replacing the word, and a literal would silently become the new name. Same for the platform driver's old id
(`packages/contracts/src/platform-legacy.ts`). Mobile ids (Expo slug, scheme, iOS bundle / Android package
`ai.agentdeck.panel`) were renamed too: a phone keeps the old app installed beside the new one.
Data MOVES BY COPY on first boot, one helper for server + `tools/` + vite: `brand.mjs`
(`<config>/<old>` → `<config>/agentdeck`, `~/.<old>` → `~/.agentdeck`, `%LOCALAPPDATA%`
likewise via keepalive; temp sibling + rename; non-empty new dir wins, never merged; copy failure ⇒ old dir
used, one log line; old dir gets `MIGRATED-TO-agentdeck.txt`). Env `AGENTDECK_X` first, the old-prefix
name (`legacyEnvName`) as fallback. Legacy block langs / hook markers / gate script name / webhook header / MCP bridge id /
`localStorage` keys are still READ (`packages/contracts/src/brand.ts`, `shared/lib/legacy-storage`). So a
"lost" state = the new dir existed non-empty before the copy (compare both, the new one wins by design);
a keepalive started before the rename still spawns the old-named server package — restart it. Proof
`node tools/qa/check-brand-migration.mjs` (real boot, throwaway home); guard `pnpm brand`
(`tools/qa/check-brand.mjs`, EMPTY allowlist for the old words, self-test included).

**Panel opens, everything zero** — wrong config dir. `/api/location` → `source` names the rule that
picked it. Order in `claude-paths.ts`, first match wins: `manual` (Settings → config dir,
remembered) → `env` (`CLAUDE_CONFIG_DIR`) → `home` (`~/.claude`). A once-set manual path beats the
env var — if the user changed it and forgot, that's the answer.

**Sandbox says `Not logged in` while normal chat works** — usually macOS, not an account problem:
the sandbox substitutes `CLAUDE_CONFIG_DIR`, so access is carried separately, and macOS has no
`.credentials.json` at all (keychain). Chain in `lib/credentials.ts`, first hit wins:
`~/.agentdeck/credentials.json` (manual, beats all) → `<config>/.credentials.json` → macOS
keychain → `ANTHROPIC_API_KEY`. Fix: read the access line of `pnpm doctor` → on macOS accept the
keychain dialog with "Always Allow" (renamed entry → `AGENTDECK_KEYCHAIN_SERVICE`) →
universal route is Settings → Claude Code access (`claudeAiOauth` | `apiKey` | `readFrom`).

**`claude not found`** — panel spawns `claude.cmd` on Windows, `claude` elsewhere; must be in the
PATH of the process that started the server.

**MCP server won't connect** — the probe is the official SDK client (`domains/mcp-client.ts`): stdio
spawns via cross-spawn (finds `.cmd` shims by PATHEXT, escapes args itself — no shell, no
`shellArgs`); `${VAR}` / `${VAR:-default}` in command/args/env/url/headers are expanded from
process env + settings env + `.mcp-secrets.env` (`readEnvLookup`), a missing one is NAMED in the
detail; stderr is decoded UTF-8 with a CP866 fallback on win32. A 401 with an own `Authorization`
header reads «token rejected», without one «OAuth needed». The result is persisted in
`state.json → mcpHealth` (card + Overview counts); stdio gets the full 45 s handshake budget.

**Jira/Confluence answers «не подключена», or the agent's Atlassian tools say the panel is down** —
one credential, two consumers, and they fail differently. The token lives ONLY in the encrypted store
(`lib/provider-keys.ts`, key `int:<id>`) and is never in a response, a prompt or `.claude.json`;
`requireConnected` refuses before any request when settings or token are missing (404, not a 502).
The agent's side is `tools/mcp/atlassian.mjs` — a proxy holding NO secret: it calls this panel's own
API, so a dead panel, a disabled integration and a network failure all read as one Russian sentence
with `isError`. Cloud vs Server/DC (Basic + `/rest/api/3` vs Bearer + `/rest/api/2`) is DETECTED by
`POST /api/integrations/atlassian/check` (the `:id/check` route) and remembered. Detail: `.agent/code-map.agent.md`
§Integrations.

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

**Every permission request is refused with «Панель перезапускалась…», or an agent keeps running after
the panel restarted** — the second is by design, the first is its edge. `node --watch` on Windows kills
the server without handlers, the CLI processes survive; the registry persists every run to
`<appData>/runs.json` and adopts the live ones at boot as `detached` (place in `/chat/active`, permission
card, Stop; no stdout — the answer is read from the transcript, no handoff/stage). Refused = the run is not
in the ledger (started before 09.09.2026, ledger unwritable, or pid dead): resend the message. The ledger
keeps the pid of `claude.exe` UNDER the `cmd.exe` wrapper — the wrapper dies with the server (`run-ledger.ts
resolveCliPid`). Proof `.agent/tmp/live-registry-restart.mjs` + `t4-tab-open.mjs`; detail
`.claude/gotchas.md` §Sessions.

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

**A fresh copy has no `.mcp.json` / `.claude/` / `.env`, or has a stray `.venv`-less run** — the local
layer is mirrored on `worktree add` by `domains/project-git/mirror-local.ts`: skip-worktree/assume-unchanged
files (flag re-set in the copy) plus git-ignored paths on the built-in list + the project's own patterns
(git popover → «Настройка копий»). What stayed behind is NAMED under the copy's card («за бортом»:
ignored top-level entries not on the list) — extend the list there, then «Обновить локальный слой»
(newer-only, the copy's edits survive). Never mirrored: `node_modules dist build coverage *.log`, > 8 MB,
links. Guard: `node tools/qa/check-worktrees.mjs`.

**A copy says «установка не удалась» right after the panel started, or a split agent's task opens with
«⚠ Подготовка копии»** — the bootstrap of the copy (`domains/project-git/bootstrap.ts`): after the mirror
the panel runs the project's command («Настройка копий» → «Команда после создания копии», empty = by the
root lockfile: pnpm/npm/yarn, none ⇒ nothing) in the copy, 10-minute ceiling, log under
`<appData>/worktree-logs/`. A record left `running` by a previous process reads as failed by design —
«Повторить установку» on the card. A failure never blocks: the copy stays, the split group still starts
and its prompt carries the log tail so the agent decides. Guard: the same `check-worktrees.mjs`.

**A child's first message starts with «Панель подготовила эту копию…», or the hub says «первая правка
через 5с»** — the clean start (T9): the split prepends a panel preamble (mirror line, install command,
reverted lockfiles, failure tail, «начинай сразу с задачи») to every group that runs in a copy, and the run
registry stamps the first `Edit|Write` into the child's link — the hub shows the delay from the work
link's creation. Lockfiles an install rewrote are reverted right after the bootstrap command
(`domains/project-git/lockfiles.ts`). Detail: `.agent/code-map-projects.agent.md` §Clean start.

**A split with runs opens with ONE chat and no copies, or a group stands with a question and no chat**
— the two-level conveyor (T1). A split at a ceiling starts a `triage` run in the repo ROOT, read-only
whatever the edits toggle says, and copies appear only after its `agentdeck:split-plan` block is
applied: a group with no `after` starts, one with `after` waits for the predecessor's whole chain and is
branched FROM its branch, one with `hold` gets no chat at all until the human answers in the parent hub
(`POST /api/chat/split/:parent/hold`, repeat ⇒ 409). Each started group then gets a `plan` run at the
ceiling in its own copy, and the work prompt carries that plan verbatim (`workAfterPlanPrompt`). No block
or a failed level never blocks: a feed notice says so and the groups run as before. Conveyor links do not
count toward the handoff cap. **A foreign CLI runs the same two levels** (Т3 of the foreign batch,
09.09.2026) — there the ceiling IS a run with no model flag, so what enables the levels is the
project's model-routing toggle, not a recognised ceiling model; the plan's chat carries no model and
its header holds what the WORK will use. Guard `tools/qa/check-split-levels.mjs` (stubs only); live
`.agent/tmp/t1-live.mjs`, foreign `.agent/tmp/f3-levels-live.mjs`; detail
`.agent/code-map-chat-split.agent.md` («Two levels before the work») plus
`.agent/code-map-foreign-chat.agent.md` («Foreign levels»).

**The agent wrote «Перезапустите сессию» / «/clear» in words and the panel started a new chat by itself; or
it did NOT and the toast says «файл-опора не изменился»** — both by design (T3). Prose in the tail of the
answer is a handoff proposal like the block (`scanHandoffProse`), the continuation's first message carries
the checkpoint AND the original task, auto-continue is on by default (an explicit `false` stored in
`state.json` still wins — the owner's stand has one), the chain cap is 8 handoffs (cascade stages excluded),
and a checkpoint whose sha1 equals the one at the previous handoff stops the chain: the agent is looping.
«Перезапустить сессию» in the chat header menu = `POST /api/chat/:id/restart` (409 while running; stale
checkpoint ⇒ the agent is asked to update it, auto forced on). Since 10.09.2026 a FOREIGN CLI does the same
with the same safeties (`domains/provider-chat/handoff.ts` reuses `evaluateHandoff`/`HandoffChains` — never
a second copy), with one difference it states out loud: there is no session, so the continuation is a NEW
chat in the same dir carrying the checkpoint and the chain's root task; button in the chat header,
`POST /api/provider-chat/chats/:id/restart`. Guards `tools/qa/check-handoff.mjs` and
`check-provider-handoff.mjs`; detail `.agent/code-map-chat.agent.md` §Handoff and
`.agent/code-map-foreign-chat.agent.md` §Foreign clean-session restart.

**The hub says «Пересечения веток: N», or it says «не сверялись» and never counts on its own** — both
by design (T6). The panel compares the split branches ONLY on the end of a group's chain and on the
«Сверить ветки» button; before that it claims nothing. The count is `git diff --name-only
<base>...<branch>` (three dots — a two-dot diff would blame the group for everything that landed in
base since) plus uncommitted in the copy, intersected across groups
(`domains/chat/split-overlap.ts`). RED is only a file outside that group's `owns` from the triage —
two rightful owners of one file are work for the merge, not a violation. A new fact is announced in
the parent's feed once (`path@groups`); the parent is usually idle, and then the notice is skipped
and the fact stays in the hub instead of being lost. Nothing is merged, rebased or checked out here
and never will be — merging stays with the user; the `after` order is a hint beside the list. A
branch git could not read is NAMED with its reason, never folded into «no overlap». **A foreign CLI
counts the same way** (Т4 of the foreign batch, 09.09.2026): the domain reads the conveyor record, not
links, so only the two ends were foreign-specific — the notice goes to the parent through
`domains/chat/parent-notice.ts` (a registry event for Claude, a `notice` reply in the provider's store
for a foreign parent, `false` still meaning «nowhere to say it»), and the hub button comes from
`ProviderChatPage` passing `useCheckOverlap`. Guards: the overlap block of `node
tools/qa/check-parent-hub.mjs` and of `check-provider-hub.mjs`; live `.agent/tmp/f4-overlap-live.mjs`.

**A group's feed shows the whole split's control panel, or a review card asks for a decision the human
never opened** — one rule behind both: a tree is always answered from its ROOT. `TreePause.view()`
walks up via `rootOf`, so a child asking for its own tree gets the parent's, and the hub is drawn only
when `tree.data.root === treeKey` (`ProviderChatPage`). Review cards split the same way: the parent
sees every review of the tree (one «ко всем» closes six MRs), a group only its own. The state is
`ChatLink.review`, NOT the cascade header — a review group has no header at all, which is why the
foreign conveyor parses that answer before reading one. The fix stage lives under the provider's OWN
chat id: the domain's temporary `new-…` key is moved onto it and dropped (`clearChatLink`). Nothing is
posted to a forge without a click, and with the integration off the button is disabled WITH the
reason. Guards: `node tools/qa/check-provider-review.mjs`, `node tools/qa/check-provider-hub.mjs`;
detail `.agent/code-map-foreign-chat.agent.md` §Foreign review by link.

**A parallel working copy refuses to be removed (409)** — an agent is running inside it. That is why
`routes/project-git-routes.ts` takes the run registry as its third argument, and the check holds for
the phone too. Copies live NEXT to the repo (`<parent>/<repo>-worktrees/<branch>`, never inside —
watchers and bundlers would recurse), and the panel never merges anything: merging stays with the
user.

**A test run ends with an empty history record, or "прогнать задетое" finds nothing** — by design, no
counter of its own. The record is assembled on finish from the case files: the panel fingerprints the
selected cases at start and stamps every case that changed with `lastRunId` (`runs.ts
stampRunResults`), clamping the agent's `lastRunAt` into the run window — the agent writes local time
with a `Z` and a "future" result used to leak into the next run's record; stamps that older behaviour left
in the future are repaired once per process on the first read (`repair.ts`, skipped while a run or manual
session holds the project). A case the agent never touched leaves the record empty; `generate`/`explore`
never produce results, and a run's own proposals land in its draft, never in a group file. Impact = `git status
--porcelain -uall` (without `-uall` a new folder collapses to `src/` and matches no `codePaths`) →
`codePaths` → the `area` word; nothing attributed ⇒ empty list, never "run everything".
Detail: `.agent/code-map-tests.agent.md`.
Every one of those reads goes through `gitSync`, whose 5 s cap is meant for ONE thing — the sync
"did the work change anything?" of the completion planner — and which returns a bare `undefined` for
"not a repo", "no git" and "timed out" alike. A tree-walking read (`status -uall`, `diff`, `ls-files`,
`log --follow`) takes `GIT_READ_TIMEOUT_MS` instead: on the short cap a big repo, a slow disk or an
antivirus turned a plain timeout into "nothing changed" or, in `generate-sources`, into «каталог не
репозиторий или такой ветки нет» about a repository and a branch that were both there. Reason needed
in a message ⇒ `gitSyncOutcome`, which names `timeout` / `no-git` / `failed`. That mismatch is also
what reddened `pnpm test` with a DIFFERENT set of files each run (fixed 10.09.2026, with
`hookTimeout` — the hooks that `git init` real repos had kept the 10 s default while `testTimeout`
was raised long ago).

**A red case does not fail `pnpm tests report`, or a CI junit shows it as skipped** — quarantine, by
design. `muted` removes exactly one right, colouring the run: the case still runs, keeps its real
status, stays visible, `muteReason` says why. `export-cases.ts` → `<skipped>` with that reason;
`tools/tests-cli.mjs report` neither counts it nor exits 1. Want the gate red → clear the flag, do
not delete the case.

**Coverage matrix shows only what is already linked / a requirement reads «uncovered»** — by design,
and stated on screen. Requirements = case links (`links[type=requirement|issue]`, key parsed out of
the URL so one issue is one row) + JQL from the project attachment when Atlassian is on — only the
second source can surface an issue nobody linked, and its absence comes back as a `warning`.
Archived cases excluded: a requirement covered only by an archived case is covered by nothing.
`domains/project-tests/coverage.ts`; sweep `check-tests-coverage.mjs`.

**Panel "switched itself off" after a few idle hours; sometimes only one half** — nothing crashed:
the machine's janitor (`~/.claude/tools/proc-reaper`, task `ProcReaper`, every 4 h) reaped the stand
(`pnpm dev` grows from an exited shell → reads as orphaned; only the two PIDs holding a socket
survived). Fixed 2026-09-01: janitor `ProtectPorts` (5178/8888 — listener, subtree AND ancestor
chain, no age cap); repo `pnpm keepalive:install` — TCP-probes both ports every 20 s (never HTTP: a
live panel with the token gate answers 401), restarts the silent half, adopts a stand already up.
Autostart is user-level (Startup folder + 5-min pickup task). Log
`%LOCALAPPDATA%\agentdeck\keepalive.log`, state `pnpm keepalive:status`.

**A CLI pointed at a contour gets a connection refusal after a reboot** — by design, and the signed
compromise says so (`gateway-required`): the gateway is a listener of the panel's own process
(`domains/platform/gateway/listener.ts`, 127.0.0.1 only, requested port from settings), so a dead
panel means no models rather than a silent slide into the vendor cloud. `pnpm keepalive:install`
keeps the stand up. The requested port busy ⇒ the listener takes a neighbour (up to 10) and writes
the one it GOT into `state.platformGatewayPort`; everything applied to a CLI takes its port from
there (`apply/profile.ts → activeGatewaySettings`) — until 10.09.2026 it took the settings port and
sent a corporate request to whatever process had occupied it. Configs applied BEFORE a shift keep the
old address: the plan shows it as a conflict, and a re-apply WITH the target's overwrite tick closes
it — a conflict is never overwritten silently.

**An agent through a contour edits files, but a call the model wrote is ignored** — the shim, and its
grammar is deliberately narrower than "looks like a call". The contour still DROPS the client's tools
field as an extra key (`no-client-tools`), so the panel declares them as protocol TEXT and reassembles
the call out of the answer (`gateway/tool-shim/`, on by default, switch on the contour). Executed:
a block in the protocol tags, and an answer that is ENTIRELY one call — that second form is what a
mid-size model actually returns. NEVER executed: a call inside a code fence, or an object with text
around it. That is not strictness for its own sake — a fence is also how a quoted protocol and a
documentation file the agent just READ arrive, and a live run on 12.09.2026 had the real `claude.exe`
write a file out of a block the model had explicitly marked "do not run, this is an example". Every
non-executed block is NAMED in the request trace (`toolFlaws`), so «вызовов не было» never reads as a
broken panel. The model may also just describe the action instead of calling — flagged, never blocked,
and the flag stays silent on a turn whose history already holds a call. Proof is
`node tools/qa/check-tool-shim.mjs`: the REAL CLI through the real gateway, five runs (tags, whole-answer
fence, fenced example, shim off), and the file on disk is the only evidence that cannot be faked by
parsing. Detail: help «Контур» (`pages/Help/topics/Platform*`),
[docs/PLATFORM.ru.md](docs/PLATFORM.ru.md),
[.agent/code-map-platform.agent.md](.agent/code-map-platform.agent.md).

**A contour answers 403 «модель», or a chat header names a model the request never carried** — through
a contour the run's model is a REQUEST, not a decision: `sonnet`/`opus` are vendor names the contour
never heard of. `chooseRunModel` (`contracts/src/platform-models.ts`, the ONE implementation server and
both chat headers call) translates it through the contour's name map, accepts a name the probe catalog
holds, and otherwise falls back to the contour model — **naming the substitution in the header**, because
a badge showing the asked name while another one travels is the one thing nobody can discover. Reasoning
effort follows the DRIVER MANIFEST, not the probe: `driver.effort === false` ⇒ it is not sent at all, said
in a caption and signed as `no-effort`. Only `check-platform-run-env.mjs` proves the tail of this — it
reads the spawned CLI's own argv, which is how the 12.09.2026 defect surfaced (the `--model` grammar in
`lib/cli-args.ts` rejected `:` and `/`, so `qwen2.5:7b` was dropped without a word).

**The «Картинка» mode is locked, or a drawn image is nowhere in the conversation** — both by design.
The image is asked for by the PANEL, never by the CLI: the transcript is Claude Code's file and the
panel writes not one line into it, so the picture is a card in the right column plus a file under
`<appData>/media/` (bytes) with a sibling `.json` (record) — never a message, and there is no gallery.
Availability is decided ONCE on the server (`GET /api/media/images/plan`, `domains/media/images.ts`) and
answered with one of EIGHT named reasons, of which only `no-agent` locks the item — the other seven say
why there is no RASTER while the agent road still draws; a second, client-side guess would drift
from the real route — the disease `chooseRunModel` cured in Т6. Three roads: the contour as part of an
ordinary answer, through the panel's OWN gateway in the OpenAI dialect (journal, spend, DLP, 451 for
free — and the anthropic dialect would drop the `image_url` part), the contour's images handle, or the
endpoint profile's `imagesUrl`. That address is never guessed from `baseUrl`, which is also why
`openai-compat` declares `images: 'none'`: a guessed `/v1/images/generations` would 404 after the human
had already described the picture (invariant 13, `probe-guess`). The prompt from the Т4 catalog is the
system message of the DRAWING model and travels only on the chat road; the menu says so, because silence
reads as «my prompt edit did not work».

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
