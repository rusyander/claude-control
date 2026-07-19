# Setup and troubleshooting

Everything needed to get Claude Control running, plus what to do when it does not.

> [!TIP]
> Would rather not dig through it by hand — open Claude Code in this folder and say
> "it won't start, figure it out". The agent reads [CLAUDE.md](CLAUDE.md), the map of this
> project written for it, runs `pnpm doctor` and fixes things itself.

🇷🇺 [Русская версия](SETUP.ru.md) · 📖 [What this project is](README.md)

---

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [Finding your `.claude` directory](#finding-your-claude-directory)
- [Platform differences](#platform-differences)
- [First run](#first-run)
- [Verifying it works](#verifying-it-works)
- [Troubleshooting](#troubleshooting)
  - [Nothing starts](#nothing-starts)
  - [The panel opens but is empty or broken](#the-panel-opens-but-is-empty-or-broken)
  - [A section does not work](#a-section-does-not-work)
  - [Changes do not take effect](#changes-do-not-take-effect)
  - [QA scripts](#qa-scripts)
- [Collecting diagnostics](#collecting-diagnostics)
- [Undoing things](#undoing-things)

---

## Requirements

|                     | Minimum     | Check with         | Notes                                                                                                                 |
| ------------------- | ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Node.js**         | **22.6**    | `node --version`   | Below this the server will not start at all — see [why](#the-server-exits-with-bad-option---experimental-strip-types) |
| **pnpm**            | 10          | `pnpm --version`   | `npm install -g pnpm`                                                                                                 |
| **Claude Code CLI** | any current | `claude --version` | Must be on `PATH` and logged in                                                                                       |
| **Git**             | any         | `git --version`    | Only needed for plugin marketplaces                                                                                   |

A `.nvmrc` is included, so `nvm use` picks the right Node.

Claude Code must be **logged in**, not just installed — run `claude` once interactively and complete authentication. The panel does not handle login and cannot do it for you; several features (chat, assistant, sandbox conversations, plugins) simply fail without it.

## Installing

```bash
git clone <repository-url>
cd claude-control
pnpm install
```

Optional, and only if you intend to run the browser QA scripts:

```bash
pnpm qa:setup     # downloads the Chromium build Playwright needs
```

## Finding your `.claude` directory

This is the folder Claude Control edits. Knowing where it is makes most problems obvious.

<table>
<tr><th>OS</th><th>Path</th><th>Open it with</th></tr>
<tr><td><b>Windows</b></td><td><code>C:\Users\&lt;you&gt;\.claude</code></td><td><code>explorer %USERPROFILE%\.claude</code></td></tr>
<tr><td><b>macOS</b></td><td><code>/Users/&lt;you&gt;/.claude</code></td><td><code>open ~/.claude</code></td></tr>
<tr><td><b>Linux</b></td><td><code>/home/&lt;you&gt;/.claude</code></td><td><code>xdg-open ~/.claude</code></td></tr>
</table>

It is a hidden folder — the leading dot. In Explorer turn on **View → Hidden items**; in Finder press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>.</kbd>.

What should be inside:

```
~/.claude/
├── CLAUDE.md              your rules
├── settings.json          hooks, permissions, environment
├── settings.local.json    personal hooks and permissions — shown, tagged "local"
├── skills/                one folder per skill
├── hooks/                 hook scripts
├── projects/              conversation transcripts
├── .credentials.json      login — never edit by hand (absent on macOS, see below)
├── .mcp-secrets.env       MCP tokens (optional)
└── claude-control/        created by this panel
    ├── state.json         groups, automations, panel settings
    └── backups/           copies before each write (last ten per file)

~/.claude.json             MCP servers and account — NOTE: beside .claude, not inside
```

> [!NOTE]
> `~/.claude.json` living next to the directory rather than inside it is a Claude Code quirk, not a mistake. MCP servers are configured there.

**If your configuration is somewhere else** — because you set `CLAUDE_CONFIG_DIR`, or you keep it on another drive — the panel will find it if that variable is set, and otherwise you can point it at the right place in **Settings → configuration directory**. That choice is remembered.

## Platform differences

The panel is written to behave the same everywhere: paths are built with Node's own helpers, the configuration directory is resolved from `CLAUDE_CONFIG_DIR` and your home directory, line endings do not matter. Very little needs hands-on attention — and all of it is collected here.

**Check your environment with one command:**

```bash
pnpm doctor
```

It changes nothing. It inspects your Node version, whether `claude` is on the `PATH`, the configuration directory, credentials and port availability, and explains every finding. Runs on all three systems.

### What actually differs

| Item              | Windows                      | macOS                                    | Linux               |
| ----------------- | ---------------------------- | ---------------------------------------- | ------------------- |
| Launching the CLI | `claude.cmd` through a shell | `claude`                                 | `claude`            |
| Credentials       | `.credentials.json`          | **Keychain**, the file usually is absent | `.credentials.json` |
| Process listing   | PowerShell                   | `ps`                                     | `ps`                |
| Path comparison   | case-insensitive             | case-sensitive                           | case-sensitive      |

The panel handles all of this itself. There is exactly one case that may need you: sandboxes on macOS.

### macOS: sandboxes and the Keychain

**Symptom.** Every section works, ordinary chat replies, but a sandbox says "Not logged in".

**Cause.** On Windows and Linux, Claude Code stores its token in `~/.claude/.credentials.json`. On macOS it keeps the token in the Keychain, and that file simply does not exist. A sandbox builds a temporary directory and runs Claude with `CLAUDE_CONFIG_DIR`, so the token has no way of getting there.

**What the panel does.** On macOS it reads the token from the Keychain itself (`security find-generic-password`). The first time, macOS asks for permission once — a dialog saying "node wants to access key…". Click **Always Allow** and it will not ask again.

**If that does not help** — say Anthropic renamed the Keychain entry. Find its name:

```bash
security dump-keychain | grep -i -A1 claude
```

Then pass the name you found through an environment variable and restart the panel:

```bash
export CLAUDE_CONTROL_KEYCHAIN_SERVICE="Claude Code-credentials"
pnpm dev
```

**The way that always works: set access by hand in the panel.** It depends neither on the Keychain nor on where the file lives, and it overrides the automatic source — see [Setting access by hand](#setting-access-by-hand).

**The blunt workaround, if the Keychain is unavailable** (corporate policy, running over SSH). Write the token to a file — both Claude Code and the panel will read it from there:

```bash
security find-generic-password -s "Claude Code-credentials" -w > ~/.claude/.credentials.json
chmod 600 ~/.claude/.credentials.json
```

The file holds JSON shaped like this:

```json
{
  "claudeAiOauth": {
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1784000000000,
    "scopes": ["user:inference"]
  }
}
```

> [!WARNING]
> This is a real access token for your account. The `600` permissions are not optional, and a file like this must never reach a repository. Only do it where the Keychain genuinely is not reachable: when the token expires Claude Code refreshes the Keychain entry, not the file, so the copy goes stale and has to be exported again.

### Setting access by hand

The fallback on any system, for when the automatic source is not found or does not fit. It works the same on Windows, macOS and Linux, and it **overrides** the automatic one — which is the point: you set it precisely when the automatic one does not work.

> [!NOTE]
> Exactly one thing needs this: the **sandbox**. Chat, the form assistant, plugins and MCP run `claude` against your real directory, where the CLI handles authentication itself. If you do not use sandboxes, there is nothing to set.

**Step by step:**

1. Open **Settings** → the **Claude Code access** card. The badge next to the title shows the current source: _settings file_, _macOS Keychain_, _set manually_, _API key_ or _not found_.
2. Click **Set manually**.
3. Pick a template — **Subscription token**, **API key** or **Your own file** — and fill in your values.
4. **Save.** Input is validated immediately: invalid JSON or a missing field shows an error right there, rather than later as a sandbox failure.
5. The badge changes to **set manually**. **Remove manual** brings the automatic source back.

**Three shapes — pick whichever fits:**

<table>
<tr><th>When</th><th>JSON</th></tr>
<tr><td>You have a <b>subscription token</b> (the same thing that lives in <code>.credentials.json</code>)</td><td>

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

</td></tr>
<tr><td>You have an <b>Anthropic API key</b> — billing goes through API rates rather than your subscription</td><td>

```json
{ "apiKey": "sk-ant-api03-…" }
```

</td></tr>
<tr><td>The token lives in <b>your own file</b> somewhere non-standard</td><td>

```json
{ "readFrom": "/full/path/to/credentials.json" }
```

</td></tr>
</table>

Only one of the three fields is required. For `claudeAiOauth` the minimum is a non-empty `accessToken`; the rest is passed through as-is.

**What happens to what you enter.** It is saved to `~/.claude-control/credentials.json` with `600` permissions. It is never sent back to the browser: the panel reports the source, never the token itself. You can also create that file by hand without the UI — the panel picks it up on the next read.

**Source order** (first match wins):

1. `~/.claude-control/credentials.json` — set by hand
2. `<config>/.credentials.json` — the system file (Windows, Linux)
3. the macOS Keychain
4. the `ANTHROPIC_API_KEY` environment variable

### Linux

Nothing special. One thing worth knowing: the filesystem is case-sensitive, so the path to your configuration directory has to match letter for letter — `~/.Claude` and `~/.claude` are different directories.

Installing browsers for the QA scripts needs administrator rights:

```bash
sudo pnpm qa:setup
```

The panel itself does not need browsers — only the runs in `tools/qa/`.

### Windows

Nothing special. `claude.cmd` is launched through a shell, and the panel quotes arguments containing spaces itself.

If your configuration lives on another drive, point the variable at it:

```powershell
$env:CLAUDE_CONFIG_DIR = "D:\claude-config"
pnpm dev
```

## First run

```bash
pnpm dev
```

This starts both halves. The browser opens by itself.

|           | Address               |                           |
| --------- | --------------------- | ------------------------- |
| **Panel** | http://localhost:8888 | what you use              |
| **API**   | http://127.0.0.1:5178 | local only, never exposed |

To run them separately — useful when debugging one of them:

```bash
cd apps/server && pnpm dev      # API only
cd apps/web && pnpm dev         # frontend only
```

Custom ports:

```bash
PORT=5200 API_PORT=5200 pnpm dev
```

> [!WARNING]
> If you change the **frontend** port, also set `WEB_PORT` for the server — it only accepts requests from the panel's own origin, and an unexpected origin is refused with a 403. Example: `WEB_PORT=9000 pnpm dev`.

On startup the server prints where it found your configuration:

```
Claude Control API: http://127.0.0.1:5178
Configuration directory: C:\Users\you\.claude (source: home)
```

`source` tells you which rule matched: `manual` (set in the panel), `env` (`CLAUDE_CONFIG_DIR`), `home` (the default), or `not-found`.

## Verifying it works

Start with the automatic check — it is also the first step for any problem:

```bash
pnpm doctor
```

Then a quick pass that touches the parts most likely to be misconfigured:

1. **Overview** shows non-zero counts for rules, skills and hooks. Zeros everywhere mean the wrong directory — check the `source` line above.
2. **Rules** lists the sections of your `CLAUDE.md`.
3. **MCP** → _Check connection_ on a server returns a tool list. This exercises process spawning.
4. **Analytics** shows token history. This exercises transcript reading.
5. **Chat** → send "hello". This exercises the `claude` CLI end to end and is the single best smoke test.

If 1–2 work but 3–5 do not, the panel is fine and the `claude` CLI is the problem — start at [the CLI section](#claude-is-not-recognised--command-not-found).

---

## Troubleshooting

### Nothing starts

#### The server exits with `bad option: --experimental-strip-types`

Your Node is too old. The server runs TypeScript sources directly, which needs **Node 22.6+**.

```bash
node --version        # if this is v20.x or v22.5 and below, that is the cause
nvm install 22 && nvm use 22
```

Without `nvm`, install a current Node from [nodejs.org](https://nodejs.org). Restart the terminal afterwards — an open shell keeps the old `PATH`.

#### `EADDRINUSE: address already in use 127.0.0.1:5178`

Something already holds the port — nearly always a server from an earlier session that was never stopped.

<details>
<summary><b>Windows</b></summary>

```powershell
Get-NetTCPConnection -LocalPort 5178 -State Listen |
  Select-Object -ExpandProperty OwningProcess |
  ForEach-Object { Get-Process -Id $_ }

Stop-Process -Id <pid> -Force
```

</details>

<details>
<summary><b>macOS / Linux</b></summary>

```bash
lsof -i :5178
kill -9 <pid>
```

</details>

Or just move: `PORT=5200 API_PORT=5200 pnpm dev`.

The frontend port is stricter — `strictPort` is on, so Vite refuses to drift to 8889 silently. Free port 8888 the same way.

> Note: `node --watch` supervises a child process, and killing the child leaves the parent confused. If the server stops responding after a crash, stop it fully and start it again rather than waiting for the watcher.

#### `pnpm: command not found`

```bash
npm install -g pnpm
```

Do not substitute `npm install` — this is a pnpm workspace, and npm will not link the `packages/contracts` dependency correctly.

#### Install fails on a lockfile mismatch

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

If it still fails, `pnpm install --no-frozen-lockfile` will resolve fresh versions — at the cost of no longer matching the committed lockfile.

---

### The panel opens but is empty or broken

#### Every section shows zero

The panel is reading the wrong directory, or a directory that is not a Claude Code configuration.

1. Look at the server's startup line, or open **Settings** — the resolved path and its source are shown.
2. Confirm the path actually contains `CLAUDE.md` and `settings.json` ([what should be there](#finding-your-claude-directory)).
3. If it is wrong, set it in **Settings → configuration directory**. An invalid path is rejected rather than applied, so the panel cannot be left pointing at nothing.

A common cause is a stale `CLAUDE_CONFIG_DIR` left over from an experiment:

```bash
echo $CLAUDE_CONFIG_DIR          # macOS / Linux
echo $env:CLAUDE_CONFIG_DIR      # Windows PowerShell
```

#### `127.0.0.1:8888` does not respond, but `localhost:8888` does

On systems where `localhost` resolves to `::1` first, a dev server bound to `localhost` ends up on IPv6 only, and IPv4-based tools cannot reach it. The config pins `host: '127.0.0.1'` to avoid this. If you removed that, put it back in `apps/web/vite.config.ts`, or just use `localhost` consistently.

#### Requests fail with 403

The API only accepts its own panel as an origin. This shows up when the frontend runs on a port the server does not expect — for example if you changed the Vite port without telling the server.

Start both with matching values:

```bash
WEB_PORT=9000 pnpm dev
```

This is deliberate: without the restriction, any website open in your browser could read your tokens through the local API. Do not widen it to `origin: true`.

#### The UI does not react to external file edits

Live updates come from a file watcher, which is a setting. Check **Settings → watch files**. It is on by default, but it is worth turning off on network filesystems and some containers where filesystem events are unreliable — use the refresh button instead.

---

### A section does not work

#### `claude` is not recognised / command not found

Everything AI-driven — chat, the form assistant, plugins, sandbox conversations, MCP checks — starts the `claude` CLI. It must be on the `PATH` of the process that runs the server.

```bash
claude --version
```

If your shell finds it but the panel does not, the server was started from an environment without it — a GUI terminal launched before installation, or an IDE with a cached environment. Close the terminal, open a new one, and start `pnpm dev` again.

<details>
<summary><b>Checking where it resolves from</b></summary>

```powershell
(Get-Command claude).Source        # Windows
```

```bash
which claude                       # macOS / Linux
```

</details>

#### Chat answers "Not logged in"

The CLI is installed but unauthenticated. Run `claude` in a terminal and complete login. The panel deliberately has no login flow — credentials stay Claude Code's business.

This is also the most common sandbox failure — see [the sandbox entry below](#a-sandbox-says-not-logged-in).

#### The plugins page is empty or shows a CLI error

That page is a thin wrapper over `claude plugin`. Check the command directly:

```bash
claude plugin list --json
claude plugin list --available        # this one goes to the network
```

Marketplace listing clones git repositories, so it needs `git` and network access, and it can take a while on first run — the panel allows three minutes before giving up. Whatever the CLI prints is shown to you unedited, on purpose.

#### An MCP server never connects

Test the command by hand first — the panel runs exactly what is in your configuration:

```bash
npx -y @modelcontextprotocol/server-filesystem ~/projects
```

Common causes:

- **The command is not on `PATH`.** `npx`, `uvx` and `node` must be resolvable by the server process.
- **A missing token.** Servers needing credentials read them from `~/.claude/.mcp-secrets.env`; check the key exists and the value is current. An expired token usually surfaces as a handshake that starts and then dies.
- **Slow start.** Starting a process gets up to 45 seconds — `npx` pulls the package on first run. Network servers get less: an address that stays silent for ten seconds will not answer in a minute either. Run the server once by hand to warm the cache.
- **Headers are needed.** For a server behind authentication, set them in the server form under "Request headers" (one per line, `Name=value`). Without them the check stops at a 401.
- **Interactive OAuth.** A server that requires a redirect login cannot be checked from the panel: only static headers are passed.

The MCP handshake runs for every transport — stdio, HTTP and SSE — and the reply shows the tool count. The built-in filesystem preset fills in your home directory.

#### Analytics is empty or has gaps

It reads `~/.claude/projects/*.jsonl`. An empty section means no transcripts — a fresh install, or the wrong configuration directory.

Costs are estimates from a price table. On a subscription nothing is billed per token, so read the number as volume, not money. An unrecognised model falls back to Sonnet pricing. The rates themselves are shown under **Settings → Rates used to estimate cost** and can be edited there: built-in prices go stale over time.

_Running agents_ matches processes by their command line: a CLI installed through npm runs under the name `node`, which is why matching by process name found nothing. If the section is empty while Claude Code is running, your system most likely does not allow listing other processes.

#### Sandbox conversations behave oddly

A sandbox is intentionally a near-empty Claude Code: about 30 tools instead of 165, no MCP servers, no third-party hooks. Behaviour that depends on your usual setup will not reproduce there — that is the point.

If the model claims it cannot write files, check that the sandbox actually built: the temporary directory is rebuilt from scratch each time, and a failure mid-build leaves it incomplete. Close the sandbox and open it again.

#### A sandbox says "Not logged in"

Ordinary chat works at the same time, so this is not about your account — the token never reached the temporary directory. Start with `pnpm doctor`: the credentials line says whether they were found and where from.

On **macOS** this is the usual cause: the token lives in the Keychain rather than in a file. Explanation and three ways to fix it: [Platform differences → macOS](#macos-sandboxes-and-the-keychain).

On **Windows and Linux**, check the file exists at all:

```bash
ls -l ~/.claude/.credentials.json
```

No file — log in again with `claude` in a terminal.

---

### Changes do not take effect

#### Claude Code ignores an edit made in the panel

**It almost certainly needs a restart.** Claude Code reads its configuration at startup. The panel marks these changes, but the banner is easy to miss.

Quit Claude Code completely — every window and any running session — and start it again.

If it still does not apply:

1. Confirm the entity is enabled in the panel.
2. Open the file and confirm the change is on disk (`~/.claude/CLAUDE.md`, `~/.claude/settings.json`).
3. For hooks, check the matcher: a hook with the wrong event or pattern is present and simply never fires. The sandbox event replay answers this in under a second, without spending a token.
4. For skills, confirm the folder is in `skills/` and not `skills-disabled/`, and that `SKILL.md` has valid frontmatter — malformed YAML makes a skill unloadable while still looking present.

#### A file looks wrong after an edit

Every write is backed up first. Look in `~/.claude/claude-control/backups/` for `<name>.<timestamp>.bak` and copy the version you want back over the original. The last ten copies of each file are kept — otherwise the directory would grow without limit, and it holds copies of the secrets file too.

If backups are missing, they were switched off in **Settings → back up before writing**. It is on by default and worth leaving on.

---

### QA scripts

#### `Executable doesn't exist at .../chrome-...`

Playwright's browser binaries are not installed:

```bash
pnpm qa:setup
```

On Linux this also pulls system libraries and may ask for `sudo`.

#### A script cannot find an element

The scripts drive the real UI, so they break when markup changes. Two of them also expect the author's own configuration — `check-resources.mjs` looks for specific file counts and script names and will time out on any other machine.

Point scripts at a different address with `APP_URL`:

```bash
APP_URL=http://127.0.0.1:9000 node tools/qa/screenshot.mjs light
```

Screenshots land in `.qa-screenshots/`, which is git-ignored. Run them from the repository root — output paths are relative to the working directory.

---

## Collecting diagnostics

Start with the automatic check — it covers most of what gets asked first:

```bash
pnpm doctor
```

If you need to report a problem in more detail, this is the useful set:

```bash
node --version
pnpm --version
claude --version
```

```bash
curl http://127.0.0.1:5178/api/location    # resolved config dir, validity, missing files
curl http://127.0.0.1:5178/api/system      # platform, home directory, Node, shell
curl http://127.0.0.1:5178/api/overview    # per-section counts
```

`/api/location` is usually the decisive one: it reports the path, how it was chosen, whether it is valid, and which expected files are absent.

The server logs warnings and errors to the terminal it runs in. The browser console (<kbd>F12</kbd>) covers frontend problems.

> When sharing output, redact `/api/env` — it lists variable names, and secret values are masked but names can be sensitive too.

## Undoing things

**Reverting a single edit** — easiest from the panel: **Settings → Backups**, the "Restore" button next to the copy you want. The file is replaced whole, and the state before the restore is saved as a fresh copy — so even a restore can be undone. The copies still live in `~/.claude/claude-control/backups/` (last ten per file) and can be copied back by hand.

**Resetting the panel itself** — delete `~/.claude/claude-control/state.json`. Groups, automations and panel settings go; your Claude Code configuration is untouched.

**Removing the panel completely:**

```bash
rm -rf ~/.claude-control          # chat working folders and sandboxes
rm -rf ~/.claude/claude-control   # panel state and backups
```

Then delete the repository. Nothing else is left behind: your rules, skills, hooks and MCP servers are ordinary Claude Code files and stay exactly as they are.

> [!TIP]
> Before deleting, check `~/.claude-control/chats/` for artifacts a chat produced that you still want, and keep `~/.claude/claude-control/backups/` until you are sure you need nothing from it.
