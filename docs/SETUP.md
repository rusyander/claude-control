# Setup and troubleshooting

Everything needed to get Claude Control running, and what to do when it does not.

> [!TIP]
> If you would rather not dig into it by hand, open Claude Code in this folder and say "it won't
> start, figure it out". The agent reads [CLAUDE.md](../CLAUDE.md), runs `pnpm doctor` and fixes it.

🇷🇺 [Русская версия](SETUP.ru.md) · 📖 [What this project is](../README.md) ·
🚫 [What the panel does not do](LIMITATIONS.md)

---

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [Finding your `.claude` directory](#finding-your-claude-directory)
- [Platform differences](#platform-differences)
- [First run](#first-run)
- [Verifying it works](#verifying-it-works)
- [Troubleshooting](#troubleshooting)
- [Collecting diagnostics](#collecting-diagnostics)
- [Undoing things](#undoing-things)

---

## Requirements

|                     | Minimum    | Check              | Note                                                                                                              |
| ------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Node.js**         | **22.6**   | `node --version`   | Below that the server does not start at all — [why](#the-server-exits-with-bad-option---experimental-strip-types) |
| **pnpm**            | 10         | `pnpm --version`   | `npm install -g pnpm`                                                                                             |
| **Claude Code CLI** | any recent | `claude --version` | Must be on `PATH` and logged in                                                                                   |
| **Git**             | any        | `git --version`    | Only needed for plugin marketplaces                                                                               |

The repo ships an `.nvmrc`, so `nvm use` picks the right Node by itself.

Claude Code must be **logged in**, not merely installed: run `claude` once in a terminal and
authenticate. The panel cannot log you in — without it chat, the assistant, sandbox conversations
and plugins do not work.

## Installing

```bash
git clone <repository-url>
cd claude-control
pnpm install
pnpm qa:setup     # only if you plan to run the browser QA scripts
```

## Finding your `.claude` directory

| System      | Path                     | Open with                        |
| ----------- | ------------------------ | -------------------------------- |
| **Windows** | `C:\Users\<you>\.claude` | `explorer %USERPROFILE%\.claude` |
| **macOS**   | `/Users/<you>/.claude`   | `open ~/.claude`                 |
| **Linux**   | `/home/<you>/.claude`    | `xdg-open ~/.claude`             |

The folder is hidden because of the leading dot: in Explorer enable **View → Hidden items**, in
Finder press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>.</kbd>.

```
~/.claude/
├── CLAUDE.md              your rules
├── settings.json          hooks, permissions, environment
├── settings.local.json    personal hooks and permissions — tagged "local" in the panel
├── skills/                one folder per skill
├── hooks/                 hook scripts
├── projects/              conversation transcripts
├── .credentials.json      your login — do not touch (absent on macOS, see below)
├── .mcp-secrets.env       MCP tokens (optional)
└── claude-control/        created by this panel
    ├── state.json         groups, automations, panel settings
    └── backups/           pre-write backups (last ten per file)

~/.claude.json             MCP servers and account — NOTE: beside .claude, not inside it
```

That `~/.claude.json` sits beside the folder rather than inside it is a Claude Code quirk.

**If the configuration lives elsewhere** (you set `CLAUDE_CONFIG_DIR`, or keep it on another
drive), the panel finds it through that variable; otherwise set the path by hand in
**Settings → configuration directory**. The choice is remembered.

## Platform differences

The panel behaves the same everywhere; only a few things need attention by hand. To check your
environment in one command (it changes nothing and explains every finding):

```bash
pnpm doctor
```

| What            | Windows                      | macOS                             | Linux               |
| --------------- | ---------------------------- | --------------------------------- | ------------------- |
| CLI launch      | `claude.cmd` through a shell | `claude`                          | `claude`            |
| Credentials     | `.credentials.json`          | **the Keychain**, usually no file | `.credentials.json` |
| Process listing | PowerShell                   | `ps`                              | `ps`                |
| Path comparison | case-insensitive             | case-sensitive                    | case-sensitive      |

The panel handles all of that. Exactly one case needs you: macOS with the sandbox.

### macOS: sandboxes and the Keychain

**Symptom.** Every section works, ordinary chat answers, but the sandbox says "Not logged in".

**Cause.** On Windows and Linux the token is a file, `~/.claude/.credentials.json`; on macOS it
lives in the Keychain and there is no file. The sandbox runs Claude with a substituted
`CLAUDE_CONFIG_DIR`, so the token cannot get there.

**What the panel does.** It reads the token from the Keychain itself
(`security find-generic-password`). The first access raises a permission prompt — click **Always
Allow**.

**If that did not help** (the Keychain entry was renamed, say) — find the name and pass it in:

```bash
security dump-keychain | grep -i -A1 claude
export CLAUDE_CONTROL_KEYCHAIN_SERVICE="Claude Code-credentials"
pnpm dev
```

**The route that always works:** set access by hand in the panel — see
[Setting access by hand](#setting-access-by-hand). It overrides the automatic source.

**If the Keychain is unavailable** (corporate policy, running over SSH) — put the token in a file:

```bash
security find-generic-password -s "Claude Code-credentials" -w > ~/.claude/.credentials.json
chmod 600 ~/.claude/.credentials.json
```

> [!WARNING]
> This is a real access token for your account: `600` is mandatory and such a file must never reach
> a repository. It only makes sense where the Keychain truly is unavailable: Claude Code refreshes
> an expired token in the Keychain, while the file stays stale and has to be exported again.

### Setting access by hand

The fallback on any system when the automatic source is missing or unsuitable; it **overrides** the
automatic one. Exactly one thing needs it — the **sandbox**: chat, the form assistant, plugins and
MCP run `claude` in your real directory, where the CLI handles authentication itself.

1. **Settings** → the **"Claude Code access"** card. The icon shows the current source: _settings
   file_, _macOS Keychain_, _set by hand_, _API key_ or _not found_.
2. **"Set by hand"** → pick a template, paste yours → **Save**. Input is validated on the spot:
   invalid JSON or a missing field shows an error in the dialog rather than a sandbox refusal later.
3. **"Clear manual"** returns the automatic source.

Three forms, any one of them — exactly one field is required:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt": 1784000000000,
    "scopes": ["user:inference"]
  }
}
```

A subscription token, the same as in `.credentials.json`; the minimum is a non-empty `accessToken`.

```json
{ "apiKey": "sk-ant-api03-…" }
```

An Anthropic API key — billed at API rates, not against your subscription.

```json
{ "readFrom": "/full/path/to/credentials.json" }
```

The token lives in a file somewhere non-standard.

What you enter is stored in `~/.claude-control/credentials.json` with `600` permissions and is
never returned to the browser — the panel shows only the source. The same file can be created by
hand.

**Source order** (first hit wins): `~/.claude-control/credentials.json` (manual) →
`<config>/.credentials.json` (Windows, Linux) → the macOS Keychain → `ANTHROPIC_API_KEY`.

### Linux and Windows

Neither needs special steps. On Linux the file system is case-sensitive, so the configuration path
must match letter for letter (`~/.Claude` and `~/.claude` are different folders), and installing
browsers for QA needs privileges: `sudo pnpm qa:setup` (the panel itself needs no browsers).

On Windows `claude.cmd` is launched through a shell and arguments with spaces are escaped by the
panel. Configuration on another drive:

```powershell
$env:CLAUDE_CONFIG_DIR = "D:\claude-config"
pnpm dev
```

## First run

```bash
pnpm dev
```

Both halves come up and the browser opens by itself.

|           | Address               |                                    |
| --------- | --------------------- | ---------------------------------- |
| **Panel** | http://localhost:8888 | what you use                       |
| **API**   | http://127.0.0.1:5178 | local only, never exposed outwards |

Separately — handy when debugging one half; custom ports through variables:

```bash
cd apps/server && pnpm dev      # API only
cd apps/web && pnpm dev         # frontend only
PORT=5200 API_PORT=5200 pnpm dev
```

> [!WARNING]
> If you change the **frontend** port, give the server `WEB_PORT` too (`WEB_PORT=9000 pnpm dev`):
> it accepts requests only from its own panel's origin, and an unexpected origin gets a 403.

On startup the server prints where it found the configuration:

```
Claude Control API: http://127.0.0.1:5178
Configuration directory: C:\Users\you\.claude (source: home)
```

`source` names the rule that fired: `manual` (set in the panel), `env` (`CLAUDE_CONFIG_DIR`),
`home` (the default) or `not-found`.

## Verifying it works

Start with `pnpm doctor`, then walk through:

1. **Overview** shows non-zero counts of rules, skills and hooks. Zeroes everywhere mean the wrong
   directory — check the `source` line.
2. **Rules** lists the sections of your `CLAUDE.md`.
3. **MCP** → _Check connection_ returns a tool list (that verifies process spawning).
4. **Analytics** shows token history (that verifies transcript reading).
5. **Chat** → send "hi". End-to-end verification of the `claude` CLI and the best short test.

If 1–2 work but 3–5 do not, the panel is fine and the CLI is not:
[`claude` is not recognised](#claude-is-not-recognised--command-not-found).

---

## Troubleshooting

### Nothing starts

#### The server exits with `bad option: --experimental-strip-types`

Node is too old: the server runs TypeScript directly and needs **22.6+**.

```bash
node --version        # v20.x or v22.5 and below — that is the cause
nvm install 22 && nvm use 22
```

Without `nvm`, install Node from [nodejs.org](https://nodejs.org) and restart your terminal — an
open one keeps the old `PATH`.

#### `EADDRINUSE: address already in use 127.0.0.1:5178`

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

#### `pnpm: command not found`

```bash
npm install -g pnpm
```

`npm install` is not a substitute: this is a pnpm workspace and npm links `packages/contracts`
wrongly.

#### Install fails on a lockfile mismatch

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

If that does not help, `pnpm install --no-frozen-lockfile` re-resolves versions, at the price of
drifting from the lockfile.

---

### The panel opens but is empty or broken

#### Every section shows zero

The panel is reading the wrong directory.

1. Check the server's startup line or **Settings** — the path and its source are shown there.
2. Make sure `CLAUDE.md` and `settings.json` are actually at that path
   ([what should be inside](#finding-your-claude-directory)).
3. Set the right one in **Settings → configuration directory**: an invalid path is not applied, so
   you cannot send the panel nowhere.

A common cause is a variable left over from experiments:

```bash
echo $CLAUDE_CONFIG_DIR          # macOS / Linux
echo $env:CLAUDE_CONFIG_DIR      # Windows PowerShell
```

#### `127.0.0.1:8888` does not respond, but `localhost:8888` does

Where `localhost` resolves to `::1` first, a dev server bound to it comes up on IPv6 only. That is
why `apps/web/vite.config.ts` sets `host: '127.0.0.1'` explicitly — if you removed it, put it back.

#### Requests fail with 403

The API accepts only its own panel as an origin: change the Vite port without telling the server
and you get this. Run both consistently, `WEB_PORT=9000 pnpm dev`. The restriction is deliberate —
without it any open website could read your tokens through the local API. Do not widen it to
`origin: true`.

#### The UI does not react to external file edits

Live updates are file watching, **Settings → watch files**. On by default, but on network file
systems and in some containers events arrive unreliably — turn it off there and use the refresh
button.

---

### A section does not work

#### `claude` is not recognised / command not found

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

#### Chat answers "Not logged in"

The CLI is installed but not authenticated: run `claude` in a terminal and log in. The panel
deliberately has no login of its own. The same cause usually breaks the sandbox — it copies
`.credentials.json`, and there is nothing to copy.

#### The plugins page is empty or shows a CLI error

The page is a thin wrapper around `claude plugin`; check the command directly:

```bash
claude plugin list --json
claude plugin list --available        # this one goes to the network
```

Fetching the catalog clones git repositories, so `git` and network access are required, and the
first run can be slow — the panel waits three minutes. Whatever the CLI prints is shown to you
unedited, deliberately.

#### An MCP server never connects

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

#### Analytics is empty or has gaps

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

#### Sandbox conversations behave oddly

A sandbox is a deliberately near-empty Claude Code: ~30 tools instead of 165, no MCP servers, no
third-party hooks. Behaviour that depends on your usual setup will not reproduce there — that is
the point. If the model says it cannot write files, the temp directory probably did not assemble
fully: close the sandbox and open it again.

#### A sandbox says "Not logged in"

Ordinary chat works, so this is not about your account: the token did not make it into the temp
directory. Start with `pnpm doctor` — the credentials line says whether they were found and where.

On **macOS** this is the most common cause; the breakdown and three fixes are in
[Platform differences → macOS](#macos-sandboxes-and-the-keychain). On **Windows and Linux** check
the file exists (`ls -l ~/.claude/.credentials.json`); if not, log in again with `claude`.

---

### Changes do not take effect

#### Claude Code ignores an edit made in the panel

**It almost certainly needs a restart** — configuration is read at startup, the panel marks such
changes but the badge is easy to miss. Close Claude Code completely, every session included.

If it still does not apply:

1. Check the entity is enabled in the panel.
2. Open the file and confirm the edit really is on disk.
3. For hooks check the matcher: a hook on the wrong event exists but never fires. Replaying the
   event in a sandbox answers this in under a second and costs no tokens.
4. For skills, the folder must be in `skills/` and not `skills-disabled/`, and `SKILL.md` must have
   valid frontmatter: with broken YAML the skill does not load although it looks present.

#### A file looks wrong after an edit

Every write is preceded by a backup: `~/.claude/claude-control/backups/`,
`<name>.<timestamp>.bak` — copy the version you want over the original. The last ten per file are
kept. No backups means they are off in **Settings → back up before writing** (on by default, best
left on).

---

### QA scripts

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

---

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

## Undoing things

**Undo one edit** — **Settings → Backups**, the "Roll back" button. The file is replaced whole and
the pre-rollback state is saved as a new backup, so the rollback itself can be rolled back. The
backups live in `~/.claude/claude-control/backups/` (last ten per file) and can still be copied by
hand.

**Reset the panel itself** — delete `~/.claude/claude-control/state.json`: groups, automations and
panel settings are gone, the Claude Code configuration is untouched.

**Remove the panel completely:**

```bash
rm -rf ~/.claude-control          # chat working folders and sandboxes
rm -rf ~/.claude/claude-control   # panel state and backups
```

Then delete the repository — nothing else is left behind: your rules, skills, hooks and MCP servers
are ordinary Claude Code files.

> [!TIP]
> Before deleting, look into `~/.claude-control/chats/` for artifacts you may still want, and keep
> `backups/` until you are sure nothing is needed from it.
