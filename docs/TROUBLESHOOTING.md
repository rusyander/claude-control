# Troubleshooting

Symptom → cause → what to do. Start with `pnpm doctor`: it explains every finding; come here when its verdict was not enough.

🇷🇺 [Русская версия](TROUBLESHOOTING.ru.md) · 🔧 [Setup](SETUP.md) · 📱 [Access from a phone](REMOTE.md) · 🚫 [What the panel does not do](LIMITATIONS.md)

---

## Contents

- [Nothing starts](#nothing-starts)
  - [The server exits with `bad option: --experimental-strip-types`](#the-server-exits-with-bad-option---experimental-strip-types)
  - [`EADDRINUSE: address already in use 127.0.0.1:5178`](#eaddrinuse-address-already-in-use-1270015178)
  - [`pnpm: command not found`](#pnpm-command-not-found)
  - [Install fails on a lockfile mismatch](#install-fails-on-a-lockfile-mismatch)
- [The panel was running and switched itself off](#the-panel-was-running-and-switched-itself-off)
- [The panel opens but is empty or broken](#the-panel-opens-but-is-empty-or-broken)
  - [Every section shows zero](#every-section-shows-zero)
  - [`127.0.0.1:8888` does not respond, but `localhost:8888` does](#1270018888-does-not-respond-but-localhost8888-does)
  - [Requests fail with 403](#requests-fail-with-403)
  - [The UI does not react to external file edits](#the-ui-does-not-react-to-external-file-edits)
- [A section does not work](#a-section-does-not-work)
  - [`claude` is not recognised / command not found](#claude-is-not-recognised--command-not-found)
  - [Chat answers "Not logged in"](#chat-answers-not-logged-in)
  - [The plugins page is empty or shows a CLI error](#the-plugins-page-is-empty-or-shows-a-cli-error)
  - [An MCP server never connects](#an-mcp-server-never-connects)
  - [Analytics is empty or has gaps](#analytics-is-empty-or-has-gaps)
  - [Sandbox conversations behave oddly](#sandbox-conversations-behave-oddly)
  - [Parallel copies show files as deleted](#parallel-copies-show-files-as-deleted)
  - [A sandbox says "Not logged in"](#a-sandbox-says-not-logged-in)
- [Changes do not take effect](#changes-do-not-take-effect)
  - [Claude Code ignores an edit made in the panel](#claude-code-ignores-an-edit-made-in-the-panel)
  - [A file looks wrong after an edit](#a-file-looks-wrong-after-an-edit)
- [QA scripts](#qa-scripts)
- [Collecting diagnostics](#collecting-diagnostics)

---

## Nothing starts

### The server exits with `bad option: --experimental-strip-types`

Node is too old: the server runs TypeScript directly and needs **22.6+**.

```bash
node --version        # v20.x or v22.5 and below — that is the cause
nvm install 22 && nvm use 22
```

Without `nvm`, install Node from [nodejs.org](https://nodejs.org) and restart your terminal — an
open one keeps the old `PATH`.

### `EADDRINUSE: address already in use 127.0.0.1:5178`

The port is taken, almost always by a server from a previous session.

```powershell
# Windows
Get-NetTCPConnection -LocalPort 5178 -State Listen |
  Select-Object -ExpandProperty OwningProcess | ForEach-Object { Get-Process -Id $_ }
Stop-Process -Id <pid> -Force
```

```bash
# macOS / Linux
lsof -i :5178
kill -9 <pid>
```

Or just move: `PORT=5200 API_PORT=5200 pnpm dev`. The frontend port is stricter — `strictPort` is
on, so Vite will not silently slide to 8889; free 8888 the same way.

> `node --watch` supervises a child process: kill the child specifically and the parent is left in
> an undefined state. Stop the server fully and start it again.

### `pnpm: command not found`

```bash
npm install -g pnpm
```

`npm install` is not a substitute: this is a pnpm workspace and npm links `packages/contracts`
wrongly.

### Install fails on a lockfile mismatch

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

If that does not help, `pnpm install --no-frozen-lockfile` re-resolves versions, at the price of
drifting from the lockfile.

---

## The panel was running and switched itself off

After a few idle hours the stand can vanish entirely or by half: the API answers and the front end does not, or the other way round. Nothing in the panel crashed. A system process janitor took it: `pnpm dev` grows from a shell that exited long ago, so the whole tree reads as orphaned, and usually only the processes holding a socket are spared — the `pnpm`, `cmd` and `node --watch` above them die, and one half of the stand is left living alone.

The repository ships a watchdog for exactly this:

```bash
pnpm keepalive:install   # add to the user's autostart
pnpm keepalive:status    # what is happening right now
pnpm keepalive:off       # remove it
```

Every 20 seconds it knocks on both ports with a plain TCP connection — not HTTP, because with the remote-access token on a live panel answers 401 — and after two silences in a row it restarts exactly the half that went quiet. A stand that is already up gets adopted, never fought for its port. Log: `%LOCALAPPDATA%\claude-control\keepalive.log`.

## The panel opens but is empty or broken

### Every section shows zero

The panel is reading the wrong directory.

1. Check the server's startup line or **Settings** — the path and its source are shown there.
2. Make sure `CLAUDE.md` and `settings.json` are actually at that path
   ([what should be inside](SETUP.md#finding-your-claude-directory)).
3. Set the right one in **Settings → configuration directory**: an invalid path is not applied, so
   you cannot send the panel nowhere.

A common cause is a variable left over from experiments:

```bash
echo $CLAUDE_CONFIG_DIR          # macOS / Linux
echo $env:CLAUDE_CONFIG_DIR      # Windows PowerShell
```

### `127.0.0.1:8888` does not respond, but `localhost:8888` does

Where `localhost` resolves to `::1` first, a dev server bound to it comes up on IPv6 only. That is
why `apps/web/vite.config.ts` sets `host: '127.0.0.1'` explicitly — if you removed it, put it back.

### Requests fail with 403

The API accepts only its own panel as an origin: change the Vite port without telling the server
and you get this. Run both consistently, `WEB_PORT=9000 pnpm dev`. The restriction is deliberate —
without it any open website could read your tokens through the local API. Do not widen it to
`origin: true`.

### The UI does not react to external file edits

Live updates are file watching, **Settings → watch files**. On by default, but on network file
systems and in some containers events arrive unreliably — turn it off there and use the refresh
button.

---

## A section does not work

### `claude` is not recognised / command not found

Everything model-powered spawns the `claude` CLI, and it must be on the `PATH` of the process that
started the server.

```bash
claude --version
(Get-Command claude).Source        # Windows: where it comes from
which claude                       # macOS / Linux
```

If your shell finds it but the panel does not, the server was started from an environment without
it (the terminal predates the CLI install, or an editor cached the environment). Open a fresh
terminal and run `pnpm dev`.

### Chat answers "Not logged in"

The CLI is installed but not authenticated: run `claude` in a terminal and log in. The panel
deliberately has no login of its own. The same cause usually breaks the sandbox — it copies
`.credentials.json`, and there is nothing to copy.

### The plugins page is empty or shows a CLI error

The page is a thin wrapper around `claude plugin`; check the command directly:

```bash
claude plugin list --json
claude plugin list --available        # this one goes to the network
```

Fetching the catalog clones git repositories, so `git` and network access are required, and the
first run can be slow — the panel waits three minutes. Whatever the CLI prints is shown to you
unedited, deliberately.

### An MCP server never connects

Check the command by hand first — the panel runs exactly what your configuration says:

```bash
npx -y @modelcontextprotocol/server-filesystem ~/projects
```

- **The command is not on `PATH`.** `npx`, `uvx` and `node` must be available to the server process.
- **A token is missing.** Credentials come from `~/.claude/.mcp-secrets.env`; an expired token
  looks like a handshake that starts and dies.
- **Slow start.** A process gets up to 45 seconds (on a first run `npx` downloads the package),
  network servers get less. Warm the cache by running the server manually once.
- **Headers are needed.** Set them in the server form, "Request headers" (`Name=value`, one per
  line). Without them the check hits a 401.
- **Interactive OAuth is needed.** Network servers have an "Authorize" button: the token is stored
  in `claude-control/mcp-oauth.json` (mode 600) and refreshed automatically. If no window opened,
  allow pop-ups. "Log out" resets it.

The handshake is done for every transport (stdio, HTTP, SSE) and the response shows the tool count.

### Analytics is empty or has gaps

It reads `~/.claude/projects/*.jsonl`. Empty means no transcripts: a fresh install, or the wrong
directory.

Cost is an estimate from Anthropic's pricing, fetched when Settings is opened (at most once a day)
into `claude-control/pricing-cache.json`; the rate is matched to the exact model version from the
transcript, and an unknown model is priced as Sonnet. Offline it falls back to the last cache, and
without one to a table baked into the panel; which is in force is visible in
**Settings → Pricing for cost estimates**, with the date and a "Refresh pricing" button. Your own
rate can be set there and overrides the fetched one.

The _running agents_ view matches processes by command line (an npm install runs under the name
`node`). Empty while Claude Code is running usually means the system does not allow listing other
processes.

### Sandbox conversations behave oddly

A sandbox is a deliberately near-empty Claude Code: ~30 tools instead of 165, no MCP servers, no
third-party hooks. Behaviour that depends on your usual setup will not reproduce there — that is
the point. If the model says it cannot write files, the temp directory probably did not assemble
fully: close the sandbox and open it again.

### Parallel copies show files as deleted

**Symptom.** Task tabs all turn red at once; the agent inside a parallel copy reports a dirty tree
and offers to "fix longpaths and restore". The git output shows

```
warning: could not open directory 'some/deep/path/…': Filename too long
 D some/deep/path/…/Component.tsx
```

**Cause.** Windows counts 260 characters for the whole path. A copy lives at
`<parent>/<repo>-worktrees/<branch>/…`, i.e. longer than the original repository, and a deeply
nested frontend has no headroom left. The files are on disk, but git cannot open them and honestly
treats them as deleted. The danger is not the red colour: `git add -A` in such a copy would record
the deletion of real files.

**What the panel does.** When it creates a copy it turns `core.longpaths` on in the repository's own
config — the config is shared by every working copy, so one write covers the main copy and all the
parallel ones. The panel always allows long paths for its own git calls, but the agent inside a copy
is a foreign process with its own config, and that would not have covered it.

**What to do yourself.** Allow long paths once per machine — that protects every repository,
including those where no copy has been created yet:

```bash
git config --global core.longpaths true
git worktree prune          # in a repository whose copies already broke
```

The system-wide Windows setting (the "Enable Win32 long paths" policy, or `LongPathsEnabled = 1` in
the registry) lifts the limit more broadly — not only for git. `pnpm doctor` shows whether either of
the two is on.

### A sandbox says "Not logged in"

Ordinary chat works, so this is not about your account: the token did not make it into the temp
directory. Start with `pnpm doctor` — the credentials line says whether they were found and where.

On **macOS** this is the most common cause; the breakdown and three fixes are in
[Platform differences → macOS](SETUP.md#macos-sandboxes-and-the-keychain). On **Windows and Linux** check
the file exists (`ls -l ~/.claude/.credentials.json`); if not, log in again with `claude`.

---

## Changes do not take effect

### Claude Code ignores an edit made in the panel

**It almost certainly needs a restart** — configuration is read at startup, the panel marks such
changes but the badge is easy to miss. Close Claude Code completely, every session included.

If it still does not apply:

1. Check the entity is enabled in the panel.
2. Open the file and confirm the edit really is on disk.
3. For hooks check the matcher: a hook on the wrong event exists but never fires. Replaying the
   event in a sandbox answers this in under a second and costs no tokens.
4. For skills, the folder must be in `skills/` and not `skills-disabled/`, and `SKILL.md` must have
   valid frontmatter: with broken YAML the skill does not load although it looks present.

### A file looks wrong after an edit

Every write is preceded by a backup: `~/.claude/claude-control/backups/`,
`<name>.<timestamp>.bak` — copy the version you want over the original. The last ten per file are
kept. No backups means they are off in **Settings → back up before writing** (on by default, best
left on).

---

## QA scripts

`Executable doesn't exist at .../chrome-...` — the Playwright browsers are missing:
`pnpm qa:setup` (on Linux it also pulls system libraries, possibly asking for `sudo`).

The scripts drive the live UI and break when the layout changes. Two of them assume the author's
configuration: `check-resources.mjs` looks for a specific file count and specific script names and
will time out on any other machine. Point a script elsewhere with a variable:

```bash
APP_URL=http://127.0.0.1:9000 node tools/qa/screenshot.mjs light
```

Screenshots land in `.qa-screenshots/` (gitignored); run the scripts from the repository root —
output paths are resolved from the working directory.

## Collecting diagnostics

```bash
pnpm doctor                                # covers almost everything asked first
node --version && pnpm --version && claude --version

curl http://127.0.0.1:5178/api/location    # the directory found, validity, what is missing
curl http://127.0.0.1:5178/api/system      # platform, home directory, Node, shell
curl http://127.0.0.1:5178/api/overview    # per-section counters
```

`/api/location` is usually decisive: the path, the rule that chose it, whether it is valid and
which expected files are missing. Warnings go to the terminal the server runs in; frontend problems
to the browser console (<kbd>F12</kbd>).

> Before sharing output, scrub `/api/env`: secret values are masked, but variable names can be
> sensitive too.
