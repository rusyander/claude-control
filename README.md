# Claude Control

**Every Claude Code setting in one place.**

A local web panel for [Claude Code](https://claude.com/claude-code): it reads and edits the real files on disk — `CLAUDE.md`, `settings.json`, skills, hooks, MCP servers — through a UI instead of by hand in JSON and Markdown. Plus a sandbox, where a change is tested before it becomes your daily setup.

Runs entirely on your machine: no account, no server, no telemetry.

By default the panel configures Claude Code, where everything is available; it also edits the configuration of Codex, Gemini, Qwen Code, Continue, Goose, Kimi Code, Cursor, OpenCode and Aider — each in its native format, see [CLIs other than Claude](#clis-other-than-claude).

🇷🇺 [Русская версия](README.ru.md) · 🔧 [Setup](docs/SETUP.md) · 🛠 [Troubleshooting](docs/TROUBLESHOOTING.md) · 🏗 [How it works](docs/ARCHITECTURE.md) · 🔒 [Security](docs/SECURITY.md) · 📱 [Access from a phone](docs/REMOTE.md) · 💬 [Chat and parallel agents](docs/CHAT.md) · 👥 [Groups](docs/GROUPS.md) · 🧑‍💻 [Development](docs/DEVELOPMENT.md) · 🚫 [What the panel does not do](docs/LIMITATIONS.md)

> [!TIP]
> **Won't start?** `pnpm doctor` explains every finding. Still stuck — open Claude Code in this
> folder and say "it won't start, figure it out": it reads [CLAUDE.md](CLAUDE.md), the map of this
> project written for the agent, and starts with diagnostics rather than with the code.

---

## Why

Claude Code's configuration is plain files, which is a good decision while there are few of them. Then comes a thousand-line `CLAUDE.md`, dozens of skill folders, hooks three levels deep in `settings.json`, MCP servers in a different file altogether, permissions nobody remembers adding. Three simple questions get hard: **what is actually active right now, what does this hook fire on, what breaks if I add this rule.**

The panel answers them: a visible shape, a switch that deletes nothing, and a sandbox where a change is tested against real Claude Code before it becomes permanent.

## What it does

<table>
<tr><td width="50%" valign="top">

**Configuration**

- **Rules** — the `## ПРАВИЛО:` sections of `CLAUDE.md`, each with search and its own switch; a separate page edits the whole file
- **Skills** — the `skills/` folder: file tree, editor, rename, a library of `SKILL.md` templates
- **Commands** — everything invoked through `/` in one list: skills, command files, plugins, built-in CLI commands — with a description, an owner and a jump to editing
- **Hooks** — grouped by event, matcher shown explicitly, order within an event rearranged by hand
- **Scripts** — files from `hooks/`, nested folders included, with a flag on the ones nothing calls
- **MCP servers** — a real protocol-level connection check (stdio, HTTP, SSE), interactive OAuth login, a tool listing, and `mcp__server__tool` permissions generated from it
- **Permissions** — allow / ask / deny, `mcp__*` patterns included; entries move between `settings.json` and `settings.local.json`
- **Environment** — from `settings.json` and `.mcp-secrets.env`, secrets masked
- **Plugins** — installed ones and the marketplace catalog, source management, a scaffolder for your own
- **Projects** — the project level of a chosen folder (`CLAUDE.md`, `.mcp.json`, `.claude/settings.json`) on top of the user level; the «From the project» tab shows the project's own set — skills, hooks and rules from its `.claude` — read-only, it is edited in the project's git

</td><td width="50%" valign="top">

**Working with it**

- **Sandbox** — test a rule, skill, hook or MCP server in isolation; a hook against a prepared or custom JSON event
- **Chat** — a conversation with Claude Code inside the panel: streaming, attachments, voice, artifact preview, model and thinking depth, branching by editing a message, search, export to md/json
- **Several projects at once** — tabs, parallel agents, dev servers launched from the tab: one target per package in a monorepo, each on its own port, autostarted when the panel boots
- **Parallel branches** — one button makes a working copy of the repository for a branch (`git worktree`) next to the project and opens it as an ordinary tab: three agents on three branches never collide, a copy with a live agent cannot be removed, and the panel never merges anything
- **Task fan-out** — hand the agent a list of independent tasks and it proposes a split as a card: "do them here in turn" or "split into N chats", where every group gets its own branch, its own copy and its own chat
- **Continuing in a clean session** — once a task is closed the agent tidies its working files and offers to carry on in a new conversation: the expensive context stays behind and the new session reads the checkpoint file. By button — or on its own, if you enable auto-continue in that conversation
- **Project git** — current branch, the list of changed files, switching, creating a branch, committing, `pull` and `push` right from the tab; the section shows up only when the project has a `.git`
- **From a phone** — an Android/iOS app (`apps/mobile`) over the same API: the whole chat, the project's files and diffs read-only, git `push`, all of analytics; paired once by QR, reachable over your own Tailscale network
- **Search** — one query across rules, skills, hooks, scripts, permissions, env, MCP and plugins (secret values are never revealed)
- **History** — a line-by-line diff over the backups, rollback of a whole file or of a single hunk
- **Analytics** — token spend and estimated cost from local transcripts: hour heatmap, cache share, CSV/JSON export
- **Groups** — arbitrary sets of entities toggled together, nestable, bound to a project (start working in it and the group switches itself on) and holding a working order that compiles into an ordinary skill with a trigger hook. In detail — [Groups: bundles, binding and a working order](docs/GROUPS.md)
- **Automations** — compiled down to ordinary hooks
- **AI assistant** — describe a rule or skill in words, get a filled-in form
- **Environment transfer** — pack any provider's environment (instructions, MCP, permissions, hooks, skills, plugins) into an archive and unpack it on another machine with a new / identical / will-overwrite plan
- **Provider comparison** — two CLIs side by side, row by row per section, with MCP servers and instructions carried from one into the other
- **Model catalog** — the panel finds out which models the active provider has released and moves the default onto the newer generation of the same family
- **Your own endpoint** — a model address instead of the vendor cloud (a local model, a company gateway, a proxy): the profile is entered once and spread across the CLI's environment variables with one button; by default the token is not written into a foreign config
- **Data protection** — a local proxy between the CLI and the model: it sees every request body (the prompt, files the agent read, tool output), replaces matches with an `[ИМЯ_1]` placeholder and restores them in the reply, or refuses the request outright; it finds exactly what the rules describe
- **Prompt gate** — a ready-made `UserPromptSubmit` hook on the same rules: it rejects or flags a prompt before it is sent, with no proxy; it sees only what a human typed and cannot rewrite the text — the event does not allow it
- **Help** — every section explained with diagrams and examples, in Russian and English
- Plus the ordinary: Ctrl/Cmd+K, live file watching (edits by Claude Code show up without a refresh), a backup before every write

</td></tr>
</table>

### Disabling is soft

Disabling never deletes: a rule moves into a service section of `CLAUDE.md`, a skill into `skills-disabled/`, an MCP server under the `mcpServersDisabled` key, a hook's command into the panel's own state (it must not stay in `settings.json`, or Claude Code would keep running it). The text stays where it was; only what Claude Code sees changes — which is exactly what makes bisecting for the culprit possible.

A group toggles as a whole. The group mark is stored separately from the manual one: a member you disabled by hand does not come back when the group is enabled, and a member of two groups returns only when both release it.

## Chat and parallel agents

Not a separate bot and not an API wrapper: the same `claude` you run in the terminal, with the conversation kept in ordinary Claude Code transcripts. A chat started in the terminal shows up in the panel, and the other way round.

What the panel adds is concurrency: each project gets its own tab and its own process, and switching tabs does not stop an agent.

- **The dot on the tab** — working, waiting on an answer, or stalled; a background agent that finished or hit a question sends a notification. The edits toggle, spend in tokens, the project dev server and its git live in the same tab.
- **A branch per agent** — a working copy of the repository (`git worktree`) next to the project, opened as an ordinary tab; a copy with a live agent cannot be removed, and there is no merging in the panel at all.
- **Splitting a list of tasks across chats** and **continuing in a clean session** — the agent offers a card, the decision and the button are yours.
- **A run belongs to the server, not to the tab** — F5 and a closed tab stop nothing.

In detail — [Chat, tabs and parallel agents](docs/CHAT.md).

## CLIs other than Claude

The panel grew out of Claude Code and stays its tool: **the Claude provider is active by default, and everything is available for it.** Neighbouring agent CLIs are configured the same way — an instructions file, MCP servers, environment variables, an approval policy — and the panel edits those files directly, each in its native format. One UI instead of remembering that Codex keeps MCP in TOML, Gemini in JSON, OpenCode under a different key, and Aider writes env as a YAML list.

### Choosing a provider

**Settings → Configuration provider** (the same optional step exists in first-run onboarding). The "installed" / "config found" / "not found" badge is a hint, never coercion: the provider never switches on its own, the default stays `claude`, and writes happen only on your explicit action. No CLI on `PATH` — the configuration is still editable, and the assistant with neither CLI nor key offers instructions. After a switch the menu keeps exactly what that CLI supports.

### The map: section × provider

What actually works in each CLI — the "section × provider" table in [What the panel does not do with other CLIs](docs/LIMITATIONS-PROVIDERS.md#the-map-section--provider). File paths, the keys the panel edits and the reason behind every status — in [Providers: format details](docs/PROVIDERS.md).

Claude is marked **verified**: its path has been exercised live and is covered by tests. The rest are **experimental**: formats come from each CLI's documentation and are covered by round-trip tests, but the first real write is worth eyeballing. Which is why four tools surround them — a write preview, a provider check on your machine, a daily comparison against the published schemas, and migration of settings between CLIs ([Providers: panel-side tools](docs/PROVIDER-TOOLS.md)). Not theory: the very first format check found a drift — `experimental.hook` is gone from the OpenCode schema, so hooks there are read-only as a fact rather than a guess.

### Your subscription outranks a paid API

The assistant picks what to run in a hard order, locked by tests: **the provider's CLI on `PATH`** (your subscription, nothing extra to pay) → **an API key, only if no CLI was found** → **a modal explaining how to log in**. A stored key never overrides the CLI.

Keys you do enter are stored encrypted (AES-256-GCM) in `claude-control/provider-keys.enc`, with the passphrase in a machine-local `0600` file. Only an `sk-…1234` mask leaves the server. Keys never reach logs, backups, history, search or the exported environment archive — there is a test iterating every provider for that.

### What protects a foreign config

- **A backup before every write, and the write is atomic.** Provider backups are named `<provider>-<file>` and can never roll back over Claude's.
- **Formats come from documentation, not from memory.** Nothing undocumented exists here — neither a format nor a directory override (`CODEX_HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` for OpenCode, `QWEN_HOME` are honoured).
- **Validation before write, plus round-trip:** the file is read, changed, serialized back and compared with what was read. Mismatch — no write.
- **Surgical edits.** Codex: only the relevant region of `config.toml` changes, comments, profiles and key order stay byte-for-byte; Aider's YAML keeps its comments; `CRLF`/`LF` is preserved and a BOM is stripped on read and restored on write.
- **Fail-closed.** An unfamiliar or broken file is no reason to guess: the section returns an error and stays read-only. An unsupported capability simply has no section.

## Quick start

**Requirements:** Node.js 22.6+ (for TypeScript type stripping), pnpm 10+, and the `claude` CLI installed, logged in, and on your `PATH`.

**On Windows, one more line, once per machine:** `git config --global core.longpaths true`. Parallel working copies live at a path longer than the original, and without permission for long paths git reports real files as deleted — `git add -A` inside such a copy would record those deletions. `pnpm doctor` checks this and tells you if it is off; the full story is in [TROUBLESHOOTING.md → Parallel copies show files as deleted](docs/TROUBLESHOOTING.md#parallel-copies-show-files-as-deleted).

```bash
pnpm install
pnpm dev
```

The panel opens at **http://localhost:8888**, the API runs on **127.0.0.1:5178**.

For the phone: turn on Settings → remote access, then `pnpm remote` (raises Tailscale Serve in front of the API and prints the address), scan the QR in the app, `pnpm remote:off` to take it down. The app itself is `apps/mobile` — `pnpm mobile` builds and installs it on a connected device or emulator, `pnpm mobile:apk` drops a release APK into the repository root (Android 12+). Tailscale must be installed and logged in under your own account; without it the panel says so instead of guessing an address.

Anything unexpected — a port in use, an empty configuration directory, plugins not listing — is covered in **[SETUP.md](docs/SETUP.md)**, along with where `.claude` lives on each OS.

## Platform support

The core is portable: the home directory is always resolved through `os.homedir()`, paths through `path.join`, and text parsing tolerates both `\n` and `\r\n`.

|                                | Windows           | Linux         | macOS         |
| ------------------------------ | ----------------- | ------------- | ------------- |
| Panel, configuration editing   | ✅                | ✅            | ✅            |
| Chat, sandbox, assistant       | ✅                | ✅            | ✅            |
| MCP connection check           | ✅                | ✅            | ✅            |
| Running agents in Analytics    | ⚠️                | ⚠️            | ⚠️            |
| `.ps1` hook scripts in sandbox | ✅                | ⚠️ needs pwsh | ⚠️ needs pwsh |
| `.sh` hook scripts in sandbox  | ⚠️ needs Git Bash | ✅            | ✅            |

⚠️ **Running agents** is best-effort: agents are matched by their command line, because a CLI installed through npm runs under the name `node`, not `claude`. If listing processes is not permitted, the section stays empty.

## Known limitations

The full section-by-section breakdown is in [LIMITATIONS.md](docs/LIMITATIONS.md).

- **A restart is needed.** Claude Code loads its configuration at startup; the UI marks such changes.
- **Plugins depend on the CLI.** The page wraps `claude plugin`: if the CLI cannot reach a marketplace, the panel shows its raw output.
- **Cost is indicative.** A subscription is not billed per token, so read the number as volume of work. Pricing comes from Anthropic's site; discounts, batch rates and account-specific terms are not in it.
- **Chat runs live in the server's memory** — restarting it ends them (details above).
- **Editing a hook changes its id:** the id is derived from its content, so a saved link stops resolving and group membership has to be set again.

## License

[PolyForm Perimeter 1.0.1](LICENSE) — use, modify and redistribute it freely, at home and at work,
inside a company and in commercial projects; keep the required notice. The one thing the license
withholds is building a product that competes with this one. The software comes with no warranty.

This is a source-available licence, not an OSI-approved open-source one. Earlier commits carried an
MIT `LICENSE`; that grant stays with the snapshots that shipped it.
