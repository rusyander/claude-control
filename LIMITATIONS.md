# What the panel does not do

A section-by-section breakdown: what is limited, why, and whether it is worth waiting for.

The list was checked against the code rather than written from memory. Every entry is
marked with what it grows out of:

- **by design** — meant to be this way, no plans to change it;
- **not ours** — a limitation of Claude Code itself, of another CLI, of the operating
  system, or of the network;
- **not yet** — worth doing, the adapter is not written.

> Across the Claude Code sections there are no "not yet" or "rough edge" (behaves
> unexpectedly) entries left: everything once marked that way has been shipped — from
> group variables and nested script folders to interactive OAuth for MCP servers. The
> history of that work lives in [TASKS.md](TASKS.md). The "not yet" marker survives only
> in [CLIs other than Claude](#clis-other-than-claude): multi-provider support is not
> finished, and that is spelled out honestly below.

🇷🇺 [Русская версия](LIMITATIONS.ru.md) · 📖 [What this project is](README.md) ·
🔧 [Setup and troubleshooting](SETUP.md)

---

## General

| What                                                          | Why                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes take effect only after Claude Code restarts           | **not ours.** The CLI reads its configuration at startup. The panel marks such edits, but it cannot make someone else's process re-read anything                                                                                                              |
| One user configuration directory at a time                    | **by design.** The panel works with the `~/.claude` it found; the project level (a project's `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`) is added separately in the Projects section, but still raw: no groups, soft-disable, health, OAuth or sandbox |
| No database of its own, no history, no sync between machines  | **by design.** The source of truth is Claude Code's files. Version history is git's job, not the panel's                                                                                                                                                      |
| The API has no authentication and listens on `127.0.0.1` only | **by design.** A single-user tool for your own machine. It must not be exposed: whoever reaches it reads your tokens and registers a hook                                                                                                                     |

## Overview

| What                                                             | Why                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tiles lead into sections rather than editing in place            | **by design.** A shop window; editing lives in the sections. A tile's quick action is a jump, not an edit here |
| The "changed in the last N days" summary counts the history feed | **by design.** The number comes from the same backups as the History section, not a separate edit log          |

## Analytics

| What                                                      | Why                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| How much of the subscription limit is left is unavailable | **not ours.** It lives on Anthropic's servers and never reaches local files                                                            |
| Cost is an estimate, not a bill                           | **by design.** Tokens converted at the price list: on a subscription nothing is billed per token, so read the number as volume of work |
| Only this machine and the current directory are counted   | **by design**                                                                                                                          |
| Very large transcripts are read in parts                  | **by design.** A trade for speed: numbers taken from such files are approximate                                                        |
| Running agents show no start time on macOS and Linux      | **not ours.** `ps` does not report it, and a separate call for the sake of one column does not pay off                                 |
| Agents are recognised by their command line               | **by design.** A heuristic: a renamed binary or a wrapper will not make the list                                                       |

## Chat

| What                                                                                        | Why                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run that finishes while the page is closed returns to the feed only within a grace minute | **by design.** The buffer holds a finished run for a minute: come back in time and the feed catches up its tail; later, only the transcript keeps it                                        |
| Conversations cannot be deleted or renamed                                                  | **by design.** Transcripts belong to Claude Code; the panel only reads them                                                                                                                 |
| Full-text search over message bodies exists, but is capped                                  | **by design.** Searching inside messages was added (the "By messages" switch in the chat list); to avoid reading huge transcripts whole, the number of matches and scanned files is limited |
| The feed opens on the latest messages; earlier ones load on demand                          | **by design.** The last window shows first so a long conversation opens at all; a "Load more" button pulls in earlier messages                                                              |
| The list of created files exists only for chats outside a project                           | **by design.** Inside a real repository such a list is useless                                                                                                                              |
| Per-request permissions do nothing in full-access mode                                      | **by design.** Everything is allowed there by definition                                                                                                                                    |

## Rules

| What                                                               | Why                                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Rules section manages your personal `~/.claude/CLAUDE.md` only | **by design.** Project-level rules live in the separate Projects section (editing a project's `CLAUDE.md`); groups, soft-disable and the sandbox are not there yet |
| Rules have no priority over one another                            | **not ours.** Claude reads the file as a whole; the panel cannot settle a contradiction between two rules                                                          |
| History means whole-file copies                                    | **by design.** A restore brings back the entire `CLAUDE.md` of that moment, not one rule out of it                                                                 |
| Following a rule is not guaranteed                                 | **not ours.** A rule is an instruction. For guarantees there are permissions and hooks                                                                             |

## Skills

| What                                                     | Why                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| No versions and no edit history                          | **by design.** That is what putting a skill in git is for                         |
| Whether a skill will engage cannot be known beforehand   | **not ours.** The model decides from the description; check it with a sandbox run |
| Nested files are read only when `SKILL.md` links to them | **not ours.** Claude Code does not walk the folder                                |

## Hooks

| What                                                                 | Why                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Two fully identical hooks differ only by a suffix                    | **by design.** The identifier is derived from the content; exact duplicates are indistinguishable by definition |
| Editing the command changes the hook's identifier                    | **by design.** It is a different entry now: a saved link to it stops opening                                    |
| A local hook has no off switch                                       | **by design.** Turning it off here would mean deleting the line from your personal file                         |
| Only two events out of nine can stop an action                       | **not ours.** A Claude Code limitation                                                                          |
| No step-by-step debugging — only a run, its output and its exit code | **by design.** The input event, though, is anything you like: nine presets or your own arbitrary JSON           |
| A disabled hook's snapshot lives in the panel's `state.json`         | **by design.** Lose that file and you lose the disabled hooks                                                   |

## Scripts

| What                                                        | Why                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.ps1` outside Windows needs `pwsh` installed               | **not ours.** Without it there is no run at all; the panel says so plainly                                                                                              |
| "In use" is decided by the file name appearing in a command | **by design.** Same-named files and indirect calls are judged wrongly                                                                                                   |
| No dependency install and no scheduled runs                 | **by design.** A script gets whatever the system already has; scheduling is not what hooks are for                                                                      |
| Providers without hooks get no sandbox and no "in use" flag | **by design.** The section works everywhere, but the sandbox boots Claude Code and "in use" is read from hooks — Codex, Gemini, Cursor, OpenCode and Aider have neither |

## Plugins

| What                                                  | Why                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| An installed plugin cannot be edited or taken in part | **by design.** Its contents belong to its author. You can scaffold your own plugin, and inspect an installed one's contents |
| Everything rests on the CLI: no `claude`, no section  | **not ours.** The page is a wrapper around `claude plugin` and nothing more                                                 |
| Any operation blocks the page                         | **by design.** Plugin commands must not be interleaved                                                                      |
| Does not work without a network                       | **not ours**                                                                                                                |

## MCP servers

| What                                                               | Why                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The MCP section manages the global `~/.claude.json` only           | **by design.** A project's `.mcp.json` is edited in the Projects section — it has its own list of the project's MCP servers, but without the health check, OAuth or soft-disable |
| Individual tools of a server cannot be switched on separately      | **not ours.** A server connects whole; the picking and choosing is done with permissions                                                                                         |
| The connection check does not run by itself by default             | **by design.** Starting a server costs time. Settings has an `mcpAutoCheck` toggle that turns on an automatic check when the section opens                                       |
| The stdio timeout is fixed (45 s); the network one is configurable | **by design.** The network timeout is set in Settings (`mcpNetworkTimeoutMs`, 2000–120000 ms); launching local stdio servers stays hard-capped                                   |
| A server's secrets end up in the shared `~/.claude.json`           | **by design.** Keep the values in the Environment section; OAuth tokens are stored separately, in a file with mode 600                                                           |

## Permissions

| What                                                              | Why                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Project-level `.claude/settings.json` lives in a separate section | **by design.** Project permissions are edited in the Projects section; here, in Permissions, it is the user level only |
| There is no way to tell which rule a particular request matched   | **not ours.** The panel writes the file, but does not see the CLI's decisions                                          |
| The System tab compares patterns literally                        | **by design.** `Bash(git push:*)` and `Bash(git push origin:*)` are different things                                   |
| The order of decisions is fixed: deny > ask > allow               | **not ours**                                                                                                           |

## Environment

| What                                                     | Why                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Values are not encrypted                                 | **by design.** File permissions are the protection; an encryption key would end up lying next to them |
| A secret has to be typed again when you edit it          | **by design.** The panel keeps only the mask                                                          |
| There is no split by project                             | **by design**                                                                                         |
| There is no way to see what actually reached the process | **not ours.** The panel writes files, it does not observe the environment                             |
| A secret is recognised by the variable's name            | **by design.** The word lists used by the form and by the server do not match exactly                 |

## Projects

| What                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The project level is raw: no groups, soft-disable, health, OAuth or sandbox | **by design.** The section is additive — it edits a project's `CLAUDE.md`, `.mcp.json` and `.claude/settings.json`, but without the user-level extras                                                                                                                                                                                                                                                                                                                                                                             |
| Project hooks are not surfaced in the UI yet                                | **by design.** Only a project's rules, MCP servers and permissions are edited                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The user level stays separate                                               | **by design.** The Rules, MCP and Permissions sections still manage `~/.claude`; the project level does not replace them                                                                                                                                                                                                                                                                                                                                                                                                          |
| Other providers get a narrower project level than Claude                    | **not ours.** The project registry is shared, but only documented things are edited: project instructions (`AGENTS.md`/`GEMINI.md`), the project's MCP file (`.codex/config.toml`, `.gemini/settings.json`, `opencode.json`, `.cursor/mcp.json`), for Gemini also `.gemini/.env` plus permissions in `.gemini/settings.json`, and for Aider `<project>/.aider.conf.yml` (the `read` list and `set-env`). They have no project hooks; instead of a project instructions file Cursor gets the rules directory `.cursor/rules/*.mdc` |

## Groups

| What                                               | Why                                             |
| -------------------------------------------------- | ----------------------------------------------- |
| Claude knows nothing about groups                  | **by design.** It sees only the resulting files |
| An automation can do no more than an ordinary hook | **by design.** It compiles down to one          |

## Settings

| What                                                       | Why                                                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restores are limited to five known configuration files     | **by design.** A safeguard: the backup's name comes from the request and must not become a write path                                                      |
| Backups of `.mcp-secrets.env` sit in plain text by default | **by design.** Rotation limits how many pile up. Optional encryption is available (`encryptSecretBackups`, AES-256-GCM under a passphrase), off by default |
| There is no login and no way to view the token             | **by design.** The CLI handles authentication; only the source of access is exposed                                                                        |

## CLIs other than Claude

The panel can configure more than Claude Code, but the honest phrasing is this: **far from
everything is universal.** The full "section × provider" map lives in
[README.md](README.md#clis-other-than-claude); here are the boundaries.

### Claude-only by nature

| What                                                                     | Why                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Skills, hooks, plugins/marketplaces, token analytics, the trial sandbox  | **not ours.** This is not "we did not get to it": the other CLIs either have no such entity at all or build it on fundamentally different lines. There is nothing to port, so the sections are simply hidden |
| Rules (`## RULE:` sections inside `CLAUDE.md`)                           | **by design.** Splitting the file into named toggleable sections is this panel's convention on top of `CLAUDE.md`. With the neighbouring CLIs the instructions file is edited as a whole, without that layer |
| The rich chat: streaming, attachments, voice, branching, parallel agents | **by design.** It is built on the streaming protocol of the `claude` CLI. Other providers get a basic experimental assistant, see below                                                                      |
| History and search across every section at once                          | **by design.** With a foreign provider only its working (`ready`) sections reach the feed and the search — the panel does not read the rest at all                                                           |

### The assistant with foreign providers

| What                                                                          | Why                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With Codex, Gemini and Aider the assistant is basic: one question, one answer | **not yet.** It runs through the documented non-interactive mode (`codex exec`, `gemini -p`, `aider --message`): no streaming, attachments, history or effort selection. It is labelled experimental                                                                                                    |
| Aider's assistant has not been exercised live                                 | **honestly.** `aider` is not installed on the development machine: the runner is built from the documentation (`--message <text>` — "send a single message, process the reply, then exit") and covered by argv-shape tests, but the CLI was never actually run. The first real call is worth eyeballing |
| OpenCode has no assistant                                                     | **not yet.** No documented one-shot CLI flag was found for it, and we will not guess another CLI's arguments — the section stays a placeholder                                                                                                                                                          |
| Cursor has no assistant and will not get one                                  | **not ours.** Cursor has no model API of its own for the panel to call directly                                                                                                                                                                                                                         |
| The answer arrives whole, not token by token                                  | **not ours.** The non-interactive mode of a foreign CLI returns its result in one piece                                                                                                                                                                                                                 |

### Sections still open per provider

| What                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cursor:** a rule with unparseable frontmatter is read-only          | **by design.** Cursor's rules are a directory of `.mdc` files, and the panel does edit them (globally and per project). But when a file's frontmatter cannot be parsed, or is missing entirely, the rule opens read-only: rewriting markup the panel did not understand would be unsafe. A plain `.md` in the directory is ignored by Cursor — the panel lists such files but never touches them |
| **Aider:** instructions are not modelled the way Claude's are         | **not ours.** Aider has no single instructions file: context files are declared by the `read` option in `.aider.conf.yml`. The panel therefore edits that **list of references** (add / remove / reorder) and, separately, the contents of an already existing listed file. It never creates files of its own and never opens what the config does not reference                                 |
| **Aider:** there are no MCP servers at all                            | **not ours.** Aider's options reference has no MCP server setting whatsoever — there is nothing to configure and the section is hidden                                                                                                                                                                                                                                                           |
| **Gemini:** the `yolo` approval mode is unavailable                   | **not ours.** Per Gemini's docs it is a command-line flag only; written into `settings.json` it makes the CLI fail on startup. The panel never writes it and explains the refusal — if you need it, run `gemini --yolo`                                                                                                                                                                          |
| **OpenCode:** environment variables and permissions are a placeholder | **not yet.** It uses its own model; the adapter is not written                                                                                                                                                                                                                                                                                                                                   |
| **Everyone but Claude:** the project level is narrower                | **not yet + not ours.** Codex and OpenCode get project instructions and the project MCP file; Gemini additionally gets the project's environment variables and permissions; Cursor gets `.cursor/mcp.json` plus the rules directory `.cursor/rules/*.mdc`; Aider gets `<project>/.aider.conf.yml` (the `read` list plus `set-env`). Nobody but Claude gets project hooks                         |
| An "in development" section neither reads nor writes                  | **by design.** That is fail-closed: a placeholder instead of a guess at the format. No mutation leaves such a section                                                                                                                                                                                                                                                                            |
| Other CLIs (Kimi, Qwen, Continue, Goose) are unsupported              | **not yet.** Each needs its own format adapter and separate verification against the documentation                                                                                                                                                                                                                                                                                               |

### Care around foreign formats

| What                                                                       | Why                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every provider except Claude is marked `experimental`                      | **by design.** The formats come from each CLI's documentation and are covered by round-trip tests, but only Claude's path has been exercised live. The first real write into every foreign format is worth eyeballing (`verify-on-first-real-run`) |
| A broken or unexpectedly shaped foreign config makes the section read-only | **by design.** Fail-closed: the panel returns an error instead of "writing something plausible". The reason is visible in the UI                                                                                                                   |
| Restoring a foreign provider's backup is forbidden                         | **by design.** A provider's backups show up in history and in the diff, but nothing can be restored from them — neither the whole file nor a single hunk: bringing back a foreign config must be a deliberate manual act                           |
| Directory overrides are not honoured for everyone                          | **not ours.** Only documented variables are honoured: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` (OpenCode). Gemini, Cursor and Aider document no such variable, so their paths come from the home directory                             |
| Multi-provider support has only been exercised live on Windows             | **not yet.** The code is cross-platform (`os.homedir()`, `path.join`, CLI names and `where`/`which` covered by tests that swap the platform), but there has been no live run on macOS or Linux — see below                                         |

## Platform support

| What                                      | Why                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `.ps1` hooks outside Windows need `pwsh`  | **not ours**                                                                    |
| Agent start time on Windows only          | **not ours**                                                                    |
| On macOS credentials live in the keychain | **not ours.** The first access raises a permission prompt; details are in SETUP |

Separately and honestly: **the panel has been exercised live on Windows.** The core is
portable by construction — the home directory always through `os.homedir()`, paths through
`path.join`, text parsing equally tolerant of `\n` and `\r\n` — and the platform-dependent
places (CLI executable names, `where` versus `which`, the process-spawn wrapper) are
covered by tests that swap `process.platform` for `win32`, `darwin` and `linux`. But a test
with a swapped platform is not the same as running on a real system. Not verified live and
still open on macOS/Linux: the real `which` and real `PATH` lookups, `0600`/`0700`
permissions on key files, launching a CLI without the `cmd.exe` wrapper, the macOS keychain,
and case sensitivity of the file system. The two tests that need a real POSIX (the keychain
and `chmod 000`) are marked skipped rather than faked.
