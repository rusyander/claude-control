# Traps already paid for

On demand, NOT auto-loaded. Read only the entry matching what you are about to touch. Don't reopen
these.

## Sessions and chat

**A Claude Code session is bound to its directory.** `--resume <id>` only finds sessions of the
current `cwd`. Hence: a chat folder must never be renamed, and the working dir for continuing is
taken from the transcript itself (`findSessionCwd` in `ChatHistory.ts`). Verified against the CLI
directly.

**The chat edit toggle is on by default and persisted** (`shared/lib/chat-prefs/`). It used to
live in React state and reset on every reload — the agent stalled for no visible reason. Change
this behaviour → fix the help too: it is described in four places.

## Analytics and pricing

**A model's price belongs to its version, not its family.** The table once knew only
`opus`/`sonnet`/`haiku`, so every opus was billed $15/$75 while Opus 4.8 is $5/$25 — a threefold
overcharge, silently. Price now comes from the site (`pricing-source.ts`), matched by the LONGEST
identifier (`claude-opus-4` is a substring of `claude-opus-4-8`: arbitrary iteration order would
bill 4.8 as 4), and taken AT THE TRANSCRIPT'S TIMESTAMP — some rates change on a schedule (Sonnet 5
intro price runs through 2026-08-31).

**`Date.parse('August 31, 2026')` is local midnight.** Passing it through
`toISOString().slice(0, 10)` yields August 30 at any positive UTC offset — the price would expire
a day early. The date is assembled from local fields (`getFullYear`/`getMonth`/`getDate`). Caught
by a test, not by eye.

**Parsing someone else's markup must be able to refuse.** Pricing is Anthropic's markdown page:
columns are located by HEADER, not by index (a "1h Cache Writes" column sits between write and
read — by index it would land in read), and any surprise aborts the whole parse. Showing
yesterday's price is survivable; showing an invented one is not.

**One assistant message spans many transcript lines, and `usage.output_tokens` GROWS across them.**
Every line repeats the same `usage` object with a running total; the complete count is on the LAST
line. Deduping by `message.id|requestId` and keeping the FIRST line undercounted output by 35% on
the real `~/.claude` (39.2M vs 60.0M). `scanner.ts` buffers per response key, keeps max
`output_tokens`, and flushes at end of file.

**models.dev `experimental` is an OBJECT, not a boolean.** It describes a model's experimental
MODES (e.g. a fast mode with its own pricing) — every recent Anthropic flagship carries it. Read as
truthy it means "preview model", which is wrong; a badge built on it labelled Opus 5 experimental.
Caught only by comparing the live cache with the raw payload — the unit test passed because its
fixture repeated my own misreading. Field is not parsed at all now. General rule: a foreign JSON
field's TYPE is part of its meaning; check it in the real payload before believing the name.

**A surgical TOML region is rebuilt, not patched.** Adding one `[mcp_servers.x]` re-serialises the
whole region, so a NEIGHBOUR entry changes bytes without changing meaning (`args = ["a"]` →
`args = [ "a" ]`). Everything outside the region stays byte-for-byte. Harmless — but since IDEA-10
the user SEES it in the write preview, so don't "fix" the diff by hiding lines: the preview must show
what will actually be written.

## Enable / disable — verify the round trip

**Disabling must never equal deleting.** A disabled hook disappears from `settings.json` (else
Claude Code would run it), so its command is snapshotted in `state.json` and merged back on read.
A disabled rule moves into a service section of `CLAUDE.md`, and the parser MUST read that
section: while it skipped it, the rule vanished from the list and the next rewrite of the file
erased the text for good — the loss was caught on a live config. Tests: `rules.disabled.test.ts`,
`group-routes.integration.test.ts`.

**Entity state is two marks, manual and group** (`disabled`, `disabledByGroup` in `app-store.ts`).
Apply `store.isDisabled()` to disk, not what was requested — otherwise a single toggle re-enables
what a group is suppressing and the panel diverges from the files.

**A hook's identifier is derived from its content, not its position** (`hookId` in `hooks.ts`).
A positional id (`Stop:0:0`) shifted when a neighbour was deleted, dragging the disabled mark,
group membership and command snapshot with it. The old id lives on as `legacyId`: `store.isDisabled`
and `getGroupIdsFor` take it as a second argument, routes normalize incoming ids via `findHook`.
Keep this while users still have old `state.json` files.

**The content id's separator is a NUL byte** (`hookContentId`, `lib/hook-id.ts`). The Read tool
renders `\0` as a space, so it looks like an ordinary separator and an Edit "fixing" it silently
invalidates every stored disabled-mark, group membership and `?id=` link. Hash the same way in
`hooks.ts` and `AppStore` — computing it twice was exactly how a disabled hook came back as an
enabled phantom.

**Only settings-level hooks get remembered on disable.** A `settings.local.json` hook snapshotted
into `state.json` was re-enabled into the SHARED `settings.json` — a personal hook leaking to
everyone. Filter by `source` before `rememberDisabledHook` (`entity-toggle.ts`).

**Every settings entry carries a `source`** — the file it was read from (`settings.json` or
`settings.local.json`). Write it back to that same file: `writeHooks` filters the list by source,
routes pick the path via `targetOf`. Mix them up and a personal setting lands in the shared config
or the other way round.

## Security and I/O

**Secrets are written only through `writeSecretFile`** (`credentials.ts`): mode `0600` is set at
creation, not by a later `chmod` — in between the file would lie open.

**Atomic write CREATES the file, so it loses the target's mode.** tmp + rename means a 0600
`.credentials.json` would come back 0644 after one panel edit. `safe-io` snapshots the mode before
writing and restores it after (`fileMode`/`applyFileMode`); a NEW file whose basename is a known
secret gets 0600 outright. Same reason backup restore goes through `writeBinaryFile`, not a raw
`writeFileSync`. On Windows chmod is a no-op — POSIX-only tests are skipped there, not deleted.

**axios JSON-parses ANY response body, whatever its content type.** Fastify returns a bare string
as `text/plain`, so a purely numeric secret arrived as a number and a `{"a":1}`-shaped one as an
object — a fail-closed `typeof !== 'string'` guard then refused a legitimate save. Reading a raw
value → pass `transformResponse: [(raw) => raw]` (`EnvFormModal.buildEnvDraft`).

**The MCP OAuth callback deliberately bypasses the origin guard** (`index.ts`). A return from an
authorization server is a cross-domain navigation, i.e. inevitably `Sec-Fetch-Site: cross-site`,
which the general rule would reject. The exception is narrow: `GET /api/mcp/oauth/callback` only,
no side effects, login protected by a `state` parameter the panel generates and looks the pending
login up by (`domains/mcp-oauth.ts`). Removing it breaks login; extending it to other routes is
equally wrong. Tokens live in a separate 600 file, not in the shared `~/.claude.json`.

**`shell: true` with an argument array** produces Node's DEP0190 warning and does not escape
anything. On Windows: either one string, or `shellArgs`.

**`git status --porcelain=v2` without `-z` C-quotes paths.** Any space or non-ASCII byte comes back
as `"docs/\320\274\320\276\320\271 \321\204\320\260\320\271\320\273.md"` — every Russian filename
unreadable, and splitting the record on spaces cuts the path in half. `-z` removes both problems:
records are NUL-terminated and paths are raw. Cost of `-z`: a rename (`2 …`) puts its OLD path in
the NEXT NUL field, so the parser must consume two fields for one file or it counts the rename
twice (`parseStatus` in `domains/project-git.ts`).

**Everything the panel hands to git comes from a list git itself printed.** `checkout` and
`pull <remote> <branch>` both verify the name against `branches`/`remoteBranches` before spawning.
Not paranoia about shells (there is none — `execFile` with an array): a branch argument that is
really an option (`--upload-pack=…`) or an arbitrary ref would be accepted by git as such. Loosen
this to "pass the request string through" and the closed list stops meaning anything.

**`cmd.exe` quoting, measured on Windows 11, not recalled.** `"`-wrapping + doubling inner `"` as
`""` + doubling trailing backslashes + `cmd /d /s /v:off /c` blocks `& | < > ^ ( )` and `!VAR!` —
`\"` does NOT escape (that is a C-runtime rule cmd never learned; `a" & echo X & "b` executed).
Two things stay broken no matter the quoting: `%NAME%` still expands inside quotes, and a raw
newline TRUNCATES the command line at line 1 while exiting 0 — silently. Passing the value through
an env var (`%CC_PROMPT%` on the command line) is strictly worse: inner quotes break out and run.
Therefore `spawnCli` resolves a real `.exe` on PATH first (`lib/win-exec.ts`) and spawns it with no
shell at all; `cmd.exe` is only for a `.cmd` shim with no binary beside it, and there a multi-line
prompt is REFUSED (`flattenPrompt` joins history with `\n\n`, so truncation would hit almost every
follow-up question and answer half of it as if whole).

## Windows filesystem

**`fs.cpSync` and `fs.rmSync` break on non-Latin paths** (Node 24, Windows). `cpSync` kills the
process silently — no exception, no message, exit code 0; the test does not fail, it disappears
along with its worker. `rmSync` with `force: true` reports success while leaving the directory on
disk. Per-entry operations (`copyFileSync`, `unlinkSync`, `rmdirSync`, `readdirSync`) handle the
same paths correctly, which is why `safe-io.ts` has its own `backupEntry` and `removeEntry` — use
those, never the recursive APIs. Skill names and their file names come from the user, so Cyrillic
is expected here.

## UI

**`overflow-x: clip` next to `overflow-y: auto` degrades to `hidden`** by spec. That is why the
sidebar stayed horizontally scrollable and slid sideways following focus. Fix: scrolling on a
nested block, the panel itself `overflow: clip` (`MainLayout.module.scss`).

**Smooth animation is the absence of relayout**, not a gradually changing number. Measure the
geometry of the innards (`check-motion.mjs`), not just the outer size: an icon that "travels"
during the animation reads as a jerk.

## Code structure

**`packages/contracts` is imported into the server as `import type` only.** Re-exports carry no
file extensions and Node's ESM resolver won't resolve them — a value import compiles fine and
crashes at runtime.
