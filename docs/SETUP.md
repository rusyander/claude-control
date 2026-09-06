# Setup

Everything needed to get Claude Control running. Not running — [Troubleshooting](TROUBLESHOOTING.md).

> [!TIP]
> If you would rather not dig into it by hand, open Claude Code in this folder and say "it won't
> start, figure it out". The agent reads [CLAUDE.md](../CLAUDE.md), runs `pnpm doctor` and fixes it.

🇷🇺 [Русская версия](SETUP.ru.md) · 📖 [What this project is](../README.md) · 🛠 [Troubleshooting](TROUBLESHOOTING.md) ·
📱 [Access from a phone](REMOTE.md) · 🚫 [What the panel does not do](LIMITATIONS.md)

---

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [Finding your `.claude` directory](#finding-your-claude-directory)
- [Platform differences](#platform-differences)
  - [macOS: sandboxes and the Keychain](#macos-sandboxes-and-the-keychain)
  - [Setting access by hand](#setting-access-by-hand)
  - [Linux and Windows](#linux-and-windows)
- [First run](#first-run)
- [Verifying it works](#verifying-it-works)
- [Undoing things](#undoing-things)

---

## Requirements

|                     | Minimum    | Check              | Note                                                                                                                                |
| ------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**         | **22.6**   | `node --version`   | Below that the server does not start at all — [why](TROUBLESHOOTING.md#the-server-exits-with-bad-option---experimental-strip-types) |
| **pnpm**            | 10         | `pnpm --version`   | `npm install -g pnpm`                                                                                                               |
| **Claude Code CLI** | any recent | `claude --version` | Must be on `PATH` and logged in                                                                                                     |
| **Git**             | any        | `git --version`    | Only needed for plugin marketplaces                                                                                                 |

The repo ships an `.nvmrc`, so `nvm use` picks the right Node by itself.

**Windows, on its own line — long paths.** The panel creates parallel working copies of a repository
(`git worktree`) next to the project, and a path inside a copy is longer than the original. In a
deeply nested frontend it easily passes 260 characters, and without permission for long paths git
does not see those files at all — it reports them as **deleted**, and `git add -A` inside the copy
would record those deletions as real. Once per machine:

```bash
git config --global core.longpaths true
```

Better still, enable long paths in Windows itself (needs administrator rights): Local Group Policy
Editor → Computer Configuration → Administrative Templates → System → Filesystem → **"Enable Win32
long paths"**, or `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`.
`pnpm doctor` checks both and stays quiet if either one is on. Symptoms and details —
[Parallel copies show files as deleted](TROUBLESHOOTING.md#parallel-copies-show-files-as-deleted).

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
[`claude` is not recognised](TROUBLESHOOTING.md#claude-is-not-recognised--command-not-found).

---

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
