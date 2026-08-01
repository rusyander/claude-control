# What the panel does not do

A section-by-section breakdown: what is limited and why. Checked against the code. Two markers:
**by design** — meant to be this way; **not ours** — a limitation of Claude Code, of the OS or of
the network.

The per-CLI boundaries live in their own file:
[LIMITATIONS-PROVIDERS.md](LIMITATIONS-PROVIDERS.md).

🇷🇺 [Русская версия](LIMITATIONS.ru.md) · 📖 [What this project is](../README.md) ·
🔧 [Setup and troubleshooting](SETUP.md) · 🔌 [Providers: format details](PROVIDERS.md)

---

## General

| What                                                          | Why                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes take effect only after Claude Code restarts           | **not ours.** The CLI reads its configuration at startup; the panel marks such edits but cannot make someone else's process re-read anything |
| One configuration directory at a time                         | **by design.** The panel works with the `~/.claude` it found; the project level is a separate section, still without the user-level extras   |
| No database of its own, no history, no sync between machines  | **by design.** The source of truth is Claude Code's files; version history is git's job                                                      |
| The API has no authentication and listens on `127.0.0.1` only | **by design.** A single-user tool: whoever reaches it reads your tokens and registers a hook                                                 |

## Overview

| What                                                             | Why                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tiles lead into sections rather than editing in place            | **by design.** A shop window; editing lives in the sections                  |
| The "changed in the last N days" summary counts the history feed | **by design.** The number comes from the same backups as the History section |

## Analytics

| What                                                    | Why                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Subscription limits left are unavailable                | **not ours.** They live on Anthropic's servers and never reach local files   |
| Cost is an estimate, not a bill                         | **by design.** A subscription is not billed per token; read it as volume     |
| Only this machine and the current directory are counted | **by design**                                                                |
| Huge transcripts are read in parts                      | **by design.** A trade for speed: numbers from such files are approximate    |
| No agent start time on macOS and Linux                  | **not ours.** `ps` does not report it                                        |
| Agents are matched by their command line                | **by design.** A heuristic: a renamed binary or a wrapper will not be listed |

## Chat

| What                                                                          | Why                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run finishing while the page is closed waits one minute                     | **by design.** The buffer holds it for a grace minute; later it lives only in the transcript                                                                                                                                           |
| Conversations cannot be deleted or renamed                                    | **by design.** Transcripts belong to Claude Code; the panel only reads them                                                                                                                                                            |
| Full-text search over messages is bounded                                     | **by design.** To avoid reading gigantic transcripts whole, matches and files scanned are capped                                                                                                                                       |
| The feed opens at the latest messages                                         | **by design.** Earlier ones arrive via "Load more"                                                                                                                                                                                     |
| The created-files list exists only for chats outside a project                | **by design.** Inside a real repository it is useless                                                                                                                                                                                  |
| Per-item permissions do nothing in full-access mode                           | **by design.** Everything is allowed there by definition                                                                                                                                                                               |
| Project git has no `push` or branch deletion                                  | **by design.** The panel is not a git client; it does exactly what you need while an agent works in the repository: branch, switch, new branch, commit, `pull`. A conflict left by `pull` is not resolved here — that is terminal work |
| A commit takes every change (`git add -A`)                                    | **by design.** There is no file picking and no index editing in the panel — git is for that                                                                                                                                            |
| The panel does not assign the dev server's port — it reads it from the output | **by design.** `PORT` is ignored by everything that keeps the port in its config. A server that prints no address runs without a link — pin its port by hand                                                                           |
| Freeing a busy port kills a process by PID, and only on a button press        | **by design.** A database or a neighbouring project may live there: the panel shows who it is, the person decides                                                                                                                      |

## Rules

| What                                                | Why                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The Rules section covers only `~/.claude/CLAUDE.md` | **by design.** Project rules live in the Projects section, without groups or sandbox   |
| There is no priority between rules                  | **not ours.** Claude reads the whole file; the panel cannot resolve a contradiction    |
| History consists of whole-file backups              | **by design.** A rollback restores that moment's entire `CLAUDE.md`, not one rule      |
| Execution is not guaranteed                         | **not ours.** A rule is an instruction; for guarantees there are permissions and hooks |

## Skills

| What                                                | Why                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| No versions and no edit history                     | **by design.** That is what git is for                                     |
| Whether a skill will be picked up is not knowable   | **not ours.** The model decides from the description; test it in a sandbox |
| Nested files are read only if `SKILL.md` links them | **not ours.** Claude Code does not walk the folder                         |

## Commands

| What                                         | Why                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The section edits nothing                    | **by design.** It is a display case: editing happens in Skills or Plugins, one button away  |
| A command cannot be run from here            | **by design.** Invoking stays with the chat and the CLI                                     |
| The built-in list is maintained by the panel | **not ours.** The CLI cannot enumerate its own commands; a fresh one arrives with an update |
| Foreign descriptions are not translated      | **by design.** A skill's or plugin's description is shown exactly as written in its file    |
| Groups follow names and owners, not intent   | **by design.** A shared name prefix or one plugin are the only signals visible on disk      |

## Hooks

| What                                                         | Why                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Exact duplicates differ only by a suffix                     | **by design.** The id is derived from the content                                    |
| Editing the command changes the id                           | **by design.** It is a different entry: a saved link stops resolving                 |
| A local hook cannot be toggled off                           | **by design.** Disabling would mean deleting a line from your personal file          |
| Only two events out of nine can stop an action               | **not ours.** A Claude Code limitation                                               |
| No step debugger — only a run, its output and its exit code  | **by design.** The input event, however, is anything: nine fixtures or your own JSON |
| A disabled hook's snapshot lives in the panel's `state.json` | **by design.** Losing that file loses the disabled hooks                             |

## Scripts

| What                                                        | Why                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `.ps1` outside Windows needs `pwsh` installed               | **not ours.** The panel says so plainly                                       |
| "In use" is detected by the file name inside the command    | **by design.** Same-named files and indirect calls are detected wrongly       |
| No dependency installation and no scheduling                | **by design.** A script gets whatever the system already has                  |
| Providers without hooks get no sandbox and no "in use" flag | **by design.** The sandbox boots Claude Code, and "in use" is read from hooks |

## Plugins

| What                                                      | Why                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| An installed plugin cannot be edited or partially adopted | **by design.** The content belongs to its author; scaffold your own |
| Everything depends on the CLI: no `claude`, no section    | **not ours.** The page is a wrapper around `claude plugin`          |
| Any operation blocks the page                             | **by design.** Plugin commands must not interleave                  |
| It does not work offline                                  | **not ours**                                                        |

## MCP servers

| What                                                      | Why                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The section covers only the global `~/.claude.json`       | **by design.** A project's `.mcp.json` is edited in Projects — without health, OAuth or disabling |
| Individual server tools cannot be toggled                 | **not ours.** A server is attached whole; filtering is done with permissions                      |
| The connection check does not run by itself               | **by design.** Booting a server costs time; the `mcpAutoCheck` toggle in Settings enables it      |
| The stdio timeout is fixed (45 s), the network one is not | **by design.** Network: `mcpNetworkTimeoutMs`, 2000–120000 ms                                     |
| Server secrets end up in the shared `~/.claude.json`      | **by design.** Keep values in Environment; OAuth tokens live in a separate 600 file               |

## Permissions

| What                                                  | Why                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| A project's `.claude/settings.json` lives in Projects | **by design.** This section is the user level only                            |
| You cannot tell which rule a given request matched    | **not ours.** The panel writes the file but does not read the CLI's decisions |
| The System tab compares patterns literally            | **by design.** `Bash(git push:*)` and `Bash(git push origin:*)` differ        |
| Decision priority is fixed: deny > ask > allow        | **not ours**                                                                  |

## Environment

| What                                             | Why                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Values are not encrypted                         | **by design.** File permissions are the protection; a key would sit next to it |
| A secret is retyped when edited                  | **by design.** The panel holds only a mask                                     |
| No per-project separation                        | **by design**                                                                  |
| You cannot see what actually reached the process | **not ours.** The panel writes files, it does not observe an environment       |
| A secret is recognised by the variable's name    | **by design.** The word lists of the form and the server do not fully match    |

## Projects

| What                                                                      | Why                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The project level is raw: no groups, soft-disable, health, OAuth, sandbox | **by design.** Added additively: it edits the project's `CLAUDE.md`, `.mcp.json` and `.claude/settings.json` |
| Project hooks are not surfaced in the UI                                  | **by design.** Only rules, MCP servers and permissions are editable                                          |
| The user level stays separate                                             | **by design.** Rules, MCP and Permissions still manage `~/.claude`                                           |
| Other providers have a narrower project level                             | **not ours.** Only what is documented — the per-CLI set is in [PROVIDERS.md](PROVIDERS.md)                   |

## Groups

| What                                     | Why                                                  |
| ---------------------------------------- | ---------------------------------------------------- |
| Claude knows nothing about groups        | **by design.** It only ever sees the resulting files |
| An automation can do no more than a hook | **by design.** It compiles down to one               |

## Settings

| What                                                     | Why                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Restores are allowed into five known configuration files | **by design.** The backup name comes from the request and must not become a write path                           |
| `.mcp-secrets.env` backups are plain text by default     | **by design.** Optional encryption exists (`encryptSecretBackups`, AES-256-GCM under a password), off by default |
| No account login and no way to view the token            | **by design.** The CLI handles authentication; only the source of access is exposed                              |

## CLIs other than Claude

The panel configures more than Claude Code, but the honest wording is: **far from everything is
universal.** The per-CLI boundaries live separately —
[LIMITATIONS-PROVIDERS.md](LIMITATIONS-PROVIDERS.md). The section × provider map is in
[README.md](../README.md#clis-other-than-claude), format details in [PROVIDERS.md](PROVIDERS.md).

## Platform support

| What                                      | Why                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `.ps1` hooks outside Windows need `pwsh`  | **not ours**                                                                    |
| Agent start time on Windows only          | **not ours**                                                                    |
| On macOS credentials live in the keychain | **not ours.** The first access raises a permission prompt; details are in SETUP |

Separately and honestly: **the panel has been exercised live on Windows.** The core is portable by
construction (`os.homedir()`, `path.join`, `\n` and `\r\n` treated alike), and the
platform-dependent places — CLI executable names, `where` versus `which`, the process-spawn
wrapper — are covered by tests that swap `process.platform` for `win32`, `darwin` and `linux`. But
a swapped platform is not a real system. Still unverified on macOS/Linux: the real `which` and real
`PATH` lookups, `0600`/`0700` permissions on key files, launching a CLI without the `cmd.exe`
wrapper, the macOS keychain, and file-system case sensitivity. The two tests that need a real POSIX
(the keychain and `chmod 000`) are marked skipped rather than faked.
