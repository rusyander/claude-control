# What the panel does not do

A section-by-section breakdown: what is limited, why, and whether it is worth waiting for.

The list was checked against the code rather than written from memory. Every entry is
marked with what it grows out of:

- **by design** — meant to be this way, no plans to change it;
- **not ours** — a limitation of Claude Code itself, of the operating system, or of the network.

> There are no more "not yet" (worth doing) or "rough edge" (behaves unexpectedly)
> entries in this list: everything once marked that way has been shipped — from group
> variables and nested script folders to interactive OAuth for MCP servers. The history
> of that work lives in [TASKS.md](TASKS.md).

🇷🇺 [Русская версия](LIMITATIONS.ru.md) · 📖 [What this project is](README.md) ·
🔧 [Setup and troubleshooting](SETUP.md)

---

## General

| What                                                          | Why                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Changes take effect only after Claude Code restarts           | **not ours.** The CLI reads its configuration at startup. The panel marks such edits, but it cannot make someone else's process re-read anything |
| One configuration directory at a time                         | **by design.** The panel works with the `~/.claude` it found; project-level `.claude/settings.json` and `.mcp.json` are not its business         |
| No database of its own, no history, no sync between machines  | **by design.** The source of truth is Claude Code's files. Version history is git's job, not the panel's                                         |
| The API has no authentication and listens on `127.0.0.1` only | **by design.** A single-user tool for your own machine. It must not be exposed: whoever reaches it reads your tokens and registers a hook        |

## Overview

| What                                         | Why                                                         |
| -------------------------------------------- | ----------------------------------------------------------- |
| The page only shows things, it edits nothing | **by design.** A shop window; editing lives in the sections |
| No "what changed since yesterday" history    | **by design.** The panel keeps no database of its own       |

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

| What                                                                                        | Why                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run that finishes while the page is closed returns to the feed only within a grace minute | **by design.** The buffer holds a finished run for a minute: come back in time and the feed catches up its tail; later, only the transcript keeps it |
| Conversations cannot be deleted or renamed                                                  | **by design.** Transcripts belong to Claude Code; the panel only reads them                                                                          |
| Search covers the title, the project and the preview, not the body of the conversation      | **by design.** There is no full-text index — transcripts are too large for one                                                                       |
| The last 400 messages are shown                                                             | **by design.** Otherwise a long conversation would not open at all                                                                                   |
| The list of created files exists only for chats outside a project                           | **by design.** Inside a real repository such a list is useless                                                                                       |
| Per-request permissions do nothing in full-access mode                                      | **by design.** Everything is allowed there by definition                                                                                             |

## Rules

| What                                     | Why                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Your personal `~/.claude/CLAUDE.md` only | **by design.** Project-level rules are not managed here                                                   |
| Rules have no priority over one another  | **not ours.** Claude reads the file as a whole; the panel cannot settle a contradiction between two rules |
| History means whole-file copies          | **by design.** A restore brings back the entire `CLAUDE.md` of that moment, not one rule out of it        |
| Following a rule is not guaranteed       | **not ours.** A rule is an instruction. For guarantees there are permissions and hooks                    |

## Skills

| What                                                     | Why                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| There is no rename                                       | **not ours.** A skill's name is its folder name and its identifier at once        |
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
| No step-by-step debugging — only a run, its output and its exit code | **by design**                                                                                                   |
| A disabled hook's snapshot lives in the panel's `state.json`         | **by design.** Lose that file and you lose the disabled hooks                                                   |

## Scripts

| What                                                        | Why                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `.ps1` outside Windows needs `pwsh` installed               | **not ours.** Without it there is no run at all; the panel says so plainly                         |
| "In use" is decided by the file name appearing in a command | **by design.** Same-named files and indirect calls are judged wrongly                              |
| No dependency install and no scheduled runs                 | **by design.** A script gets whatever the system already has; scheduling is not what hooks are for |

## Plugins

| What                                                 | Why                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| A plugin cannot be built, edited, or taken in part   | **by design.** Its contents belong to its author                            |
| Everything rests on the CLI: no `claude`, no section | **not ours.** The page is a wrapper around `claude plugin` and nothing more |
| Any operation blocks the page                        | **by design.** Plugin commands must not be interleaved                      |
| Does not work without a network                      | **not ours**                                                                |

## MCP servers

| What                                                          | Why                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The global `~/.claude.json` only                              | **by design.** A project's `.mcp.json` is not read                                                                     |
| Individual tools of a server cannot be switched on separately | **not ours.** A server connects whole; the picking and choosing is done with permissions                               |
| The connection check does not run by itself                   | **by design.** Starting a server costs time                                                                            |
| Timeouts are fixed: 45 seconds for stdio, 10 for network ones | **by design.** The form has no setting for it, so a slow network server will be declared unreachable                   |
| A server's secrets end up in the shared `~/.claude.json`      | **by design.** Keep the values in the Environment section; OAuth tokens are stored separately, in a file with mode 600 |

## Permissions

| What                                                                           | Why                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A permission cannot be moved between `settings.json` and `settings.local.json` | **by design.** The file written to is the file it came from — otherwise the permission would quietly exist twice |
| Project-level `.claude/settings.json` is not supported                         | **by design.** User level only                                                                                   |
| There is no way to tell which rule a particular request matched                | **not ours.** The panel writes the file, but does not see the CLI's decisions                                    |
| The System tab compares patterns literally                                     | **by design.** `Bash(git push:*)` and `Bash(git push origin:*)` are different things                             |
| The order of decisions is fixed: deny > ask > allow                            | **not ours**                                                                                                     |

## Environment

| What                                                     | Why                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A variable cannot be moved between files                 | **by design.** As with permissions, the file is decided by where it came from                         |
| Values are not encrypted                                 | **by design.** File permissions are the protection; an encryption key would end up lying next to them |
| A secret has to be typed again when you edit it          | **by design.** The panel keeps only the mask                                                          |
| There is no split by project                             | **by design**                                                                                         |
| There is no way to see what actually reached the process | **not ours.** The panel writes files, it does not observe the environment                             |
| A secret is recognised by the variable's name            | **by design.** The word lists used by the form and by the server do not match exactly                 |

## Groups

| What                                               | Why                                                         |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Groups do not nest                                 | **by design**                                               |
| Claude knows nothing about groups                  | **by design.** It sees only the resulting files             |
| The order members are walked in cannot be set      | **by design.** They are walked in the order they are stored |
| An automation can do no more than an ordinary hook | **by design.** It compiles down to one                      |

## Settings

| What                                                   | Why                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A restore brings back the whole file                   | **by design.** A backup is a snapshot of a file; there is no returning one setting out of it          |
| Restores are limited to five known configuration files | **by design.** A safeguard: the backup's name comes from the request and must not become a write path |
| Backups of `.mcp-secrets.env` sit there in plain text  | **by design.** Rotation limits how many pile up, but does not remove the issue                        |
| There is no login and no way to view the token         | **by design.** The CLI handles authentication; only the source of access is exposed                   |

## Platform support

| What                                      | Why                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `.ps1` hooks outside Windows need `pwsh`  | **not ours**                                                                    |
| Agent start time on Windows only          | **not ours**                                                                    |
| On macOS credentials live in the keychain | **not ours.** The first access raises a permission prompt; details are in SETUP |
