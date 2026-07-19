# What the panel does not do

A section-by-section breakdown: what is limited, why, and whether it is worth waiting for.

The list was checked against the code rather than written from memory. Every entry is
marked with what it grows out of:

- **by design** — meant to be this way, no plans to change it;
- **not ours** — a limitation of Claude Code itself, of the operating system, or of the network;
- **not yet** — worth doing, nobody got to it;
- **rough edge** — behaves differently from what you would expect, and it should be fixed.

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

| What                                                             | Why                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The page only shows things, it edits nothing                     | **by design.** A shop window; editing lives in the sections                             |
| No "what changed since yesterday" history                        | **by design.** The panel keeps no database of its own                                   |
| A failed MCP server is not flagged as loudly as a broken hook    | **rough edge.** The number of failures is counted, but the tile keeps its ordinary tone |
| Backups are not mentioned at all — they show up only in Settings | **not yet**                                                                             |

## Analytics

| What                                                      | Why                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| How much of the subscription limit is left is unavailable | **not ours.** It lives on Anthropic's servers and never reaches local files                                                              |
| Cost is an estimate, not a bill                           | **by design.** Tokens converted at the rates from Settings. Those rates are maintained by hand: leave them stale and the estimate drifts |
| Current prices are not pulled from the network            | **by design.** The section works offline; the panel does not touch the network                                                           |
| No report export — neither CSV nor JSON                   | **not yet**                                                                                                                              |
| Only this machine and the current directory are counted   | **by design**                                                                                                                            |
| Very large transcripts are read in parts                  | **by design.** A trade for speed: numbers taken from such files are approximate                                                          |
| Running agents show no start time on macOS and Linux      | **not ours.** `ps` does not report it, and a separate call for the sake of one column does not pay off                                   |
| Agents are recognised by their command line               | **by design.** A heuristic: a renamed binary or a wrapper will not make the list                                                         |

## Chat

| What                                                                                   | Why                                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The session spend counter resets on reload                                             | **rough edge.** The run itself survives a reload; the counter lives in the tab's memory       |
| A run that finishes while the page is closed will not return to the feed               | **by design.** The buffer holds for a minute; the result stays in the transcript              |
| No conversation branching: editing a message copies its text into the input            | **not yet.** `--fork-session` is already wired through at runtime, there is just no UI for it |
| Conversations cannot be deleted or renamed                                             | **by design.** Transcripts belong to Claude Code; the panel only reads them                   |
| Search covers the title, the project and the preview, not the body of the conversation | **by design.** There is no full-text index — transcripts are too large for one                |
| The last 400 messages are shown                                                        | **by design.** Otherwise a long conversation would not open at all                            |
| The list of created files exists only for chats outside a project                      | **by design.** Inside a real repository such a list is useless                                |
| Per-request permissions do nothing in full-access mode                                 | **by design.** Everything is allowed there by definition                                      |

## Rules

| What                                     | Why                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Your personal `~/.claude/CLAUDE.md` only | **by design.** Project-level rules are not managed here                                                   |
| Rules have no priority over one another  | **not ours.** Claude reads the file as a whole; the panel cannot settle a contradiction between two rules |
| History means whole-file copies          | **by design.** A restore brings back the entire `CLAUDE.md` of that moment, not one rule out of it        |
| Following a rule is not guaranteed       | **not ours.** A rule is an instruction. For guarantees there are permissions and hooks                    |

## Skills

| What                                                      | Why                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| There is no rename                                        | **not ours.** A skill's name is its folder name and its identifier at once                                                 |
| A deleted skill cannot be brought back with a button      | **not yet.** A copy of the folder is in `claude-control/backups`, but restore only knows how to return configuration files |
| The path to the copy that was made is not shown in the UI | **rough edge.** The server returns it, the UI does not display it                                                          |
| No versions and no edit history                           | **by design.** That is what putting a skill in git is for                                                                  |
| Whether a skill will engage cannot be known beforehand    | **not ours.** The model decides from the description; check it with a sandbox run                                          |
| Nested files are read only when `SKILL.md` links to them  | **not ours.** Claude Code does not walk the folder                                                                         |

## Hooks

| What                                                                 | Why                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The execution order within an event cannot be set                    | **not yet.** The order is the order of entries in the file, and there is no reordering in the UI                |
| Two fully identical hooks differ only by a suffix                    | **by design.** The identifier is derived from the content; exact duplicates are indistinguishable by definition |
| Editing the command changes the hook's identifier                    | **by design.** It is a different entry now: a saved link to it stops opening                                    |
| A local hook has no off switch                                       | **by design.** Turning it off here would mean deleting the line from your personal file                         |
| Only two events out of nine can stop an action                       | **not ours.** A Claude Code limitation                                                                          |
| No step-by-step debugging — only a run, its output and its exit code | **by design**                                                                                                   |
| A disabled hook's snapshot lives in the panel's `state.json`         | **by design.** Lose that file and you lose the disabled hooks                                                   |

## Scripts

| What                                                        | Why                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `.ts` in the sandbox is run through bash                    | **rough edge.** The extension is listed as supported, but such a script will not run               |
| `.ps1` outside Windows needs `pwsh` installed               | **not ours.** Without it there is no run at all; the panel says so plainly                         |
| Nested folders inside `hooks/` are invisible                | **rough edge.** The directory is read flat                                                         |
| "In use" is decided by the file name appearing in a command | **by design.** Same-named files and indirect calls are judged wrongly                              |
| No dependency install and no scheduled runs                 | **by design.** A script gets whatever the system already has; scheduling is not what hooks are for |

## Plugins

| What                                                 | Why                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A marketplace cannot be added or removed             | **not yet.** The list is read as it is; sources are added with the `claude` command |
| A plugin cannot be built, edited, or taken in part   | **by design.** Its contents belong to its author                                    |
| Everything rests on the CLI: no `claude`, no section | **not ours.** The page is a wrapper around `claude plugin` and nothing more         |
| Any operation blocks the page                        | **by design.** Plugin commands must not be interleaved                              |
| Does not work without a network                      | **not ours**                                                                        |

## MCP servers

| What                                                          | Why                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Interactive OAuth is not supported                            | **not yet.** The handshake goes out with whatever the headers already carry; a server that redirects you to a login page cannot be checked |
| The global `~/.claude.json` only                              | **by design.** A project's `.mcp.json` is not read                                                                                         |
| Individual tools of a server cannot be switched on separately | **not ours.** A server connects whole; the picking and choosing is done with permissions                                                   |
| The connection check does not run by itself                   | **by design.** Starting a server costs time                                                                                                |
| Timeouts are fixed: 45 seconds for stdio, 10 for network ones | **by design.** The form has no setting for it, so a slow network server will be declared unreachable                                       |
| A server's secrets end up in the shared `~/.claude.json`      | **by design.** Keep the values in the Environment section                                                                                  |

## Permissions

| What                                                                           | Why                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A permission cannot be moved between `settings.json` and `settings.local.json` | **by design.** The file written to is the file it came from — otherwise the permission would quietly exist twice |
| Project-level `.claude/settings.json` is not supported                         | **by design.** User level only                                                                                   |
| There is no way to tell which rule a particular request matched                | **not ours.** The panel writes the file, but does not see the CLI's decisions                                    |
| A pattern is not checked for typos                                             | **not yet.** The mistake surfaces only in use                                                                    |
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

| What                                               | Why                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A group's variables do not work**                | **not yet.** The field is saved and shown as a badge, but it never reaches `settings.json`: switching the group on does not apply them |
| Groups do not nest                                 | **by design**                                                                                                                          |
| Conflicts inside a group are not checked           | **not yet.** Two members with opposite settings will go unnoticed                                                                      |
| Claude knows nothing about groups                  | **by design.** It sees only the resulting files                                                                                        |
| The order members are walked in cannot be set      | **by design.** They are walked in the order they are stored                                                                            |
| An automation can do no more than an ordinary hook | **by design.** It compiles down to one                                                                                                 |

## Settings

| What                                                     | Why                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A restore brings back the whole file                     | **by design.** A backup is a snapshot of a file; there is no returning one setting out of it          |
| Restores are limited to five known configuration files   | **by design.** A safeguard: the backup's name comes from the request and must not become a write path |
| Rotation depth is not configurable — ten copies per file | **not yet**                                                                                           |
| Backups of `.mcp-secrets.env` sit there in plain text    | **by design.** Rotation limits how many pile up, but does not remove the issue                        |
| Rates can be edited for the built-in models only         | **not yet.** Your own model cannot be added to the list                                               |
| There is no export or import of the panel's own settings | **not yet**                                                                                           |
| There is no login and no way to view the token           | **by design.** The CLI handles authentication; only the source of access is exposed                   |

## Platform support

| What                                      | Why                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `.ps1` hooks outside Windows need `pwsh`  | **not ours**                                                                    |
| Agent start time on Windows only          | **not ours**                                                                    |
| On macOS credentials live in the keychain | **not ours.** The first access raises a permission prompt; details are in SETUP |
