# Claude Control

**Every Claude Code setting in one place.**

A local web panel for the configuration of [Claude Code](https://claude.com/claude-code). It reads and edits the real files on your disk — `CLAUDE.md`, `settings.json`, skills, hooks, MCP servers — through a UI instead of hand-editing JSON and Markdown. It also ships a sandbox for trying a setting out before it touches your everyday setup.

Runs entirely on your machine. No account, no server, no telemetry.

By default the panel configures Claude Code, where everything is available. It can also edit the configuration of other agentic CLIs — Codex, Gemini, Cursor, OpenCode, Aider — each in its own native format: see [CLIs other than Claude](#clis-other-than-claude).

🇷🇺 [Русская версия](README.ru.md) · 🔧 [Setup and troubleshooting](SETUP.md)

> [!TIP]
> **Not starting?** Run `pnpm doctor` — the environment check explains every finding.
> If that does not help, open Claude Code in this folder and say "it won't start, figure it out".
> The root holds [CLAUDE.md](CLAUDE.md), a map of the project written for the agent: it reads
> that automatically and begins with diagnostics rather than with reading the source.

---

## Contents

- [Why](#why)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Where your data lives](#where-your-data-lives)
- [The sandbox](#the-sandbox)
- [Chat and parallel agents](#chat-and-parallel-agents)
- [CLIs other than Claude](#clis-other-than-claude)
- [Security](#security)
- [Quick start](#quick-start)
- [Platform support](#platform-support)
- [Development](#development)
- [Known limitations](#known-limitations)

---

## Why

Claude Code keeps its configuration as loose files in `~/.claude`. That is a good design — it is greppable, diffable and scriptable — but it grows. A mature setup has a thousand-line `CLAUDE.md`, a couple of dozen skill folders, hooks buried three levels deep in `settings.json`, MCP servers in a different file entirely, and permission rules nobody remembers writing.

At that point three ordinary questions get hard to answer:

- _Which rules and skills are actually active right now?_
- _This hook — what does it match, and does it still work?_
- _If I add this rule, what breaks?_

Claude Control answers all three. It gives the configuration a shape you can see, an off switch that does not destroy anything, and a sandbox where you can test a change against the real Claude Code before it becomes your daily setup.

## What it does

<table>
<tr><td width="50%" valign="top">

**Configuration**

- **Rules** — `## RULE:` sections of `CLAUDE.md`, individually searchable and toggleable; a separate page shows and edits the whole `CLAUDE.md`
- **Skills** — the `skills/` folder, with a file tree and editor per skill; rename and a `SKILL.md` template library
- **Hooks** — grouped by lifecycle event, with the matcher shown plainly, reorderable within an event
- **Scripts** — the files in `hooks/`, including nested folders, flagged when nothing calls them
- **MCP servers** — with a real connection check over the MCP protocol: stdio, HTTP and SSE; interactive OAuth sign-in for network ones; a helper lists a server's tools and creates `mcp__server__tool` permissions for them
- **Permissions** — allow / ask / deny, including `mcp__*` patterns; an entry moves between `settings.json` and `settings.local.json`
- **Environment** — from `settings.json` and `.mcp-secrets.env`, secrets masked; an entry moves between files
- **Plugins** — installed set plus the marketplace catalogue, with sources you can add and remove; inspect an installed plugin's contents and scaffold your own
- **Projects** — the project level: a chosen folder's own `CLAUDE.md`, MCP servers (`.mcp.json`) and permissions (`.claude/settings.json`), additive to the user level

</td><td width="50%" valign="top">

**Working with it**

- **Sandbox** — try a rule, skill, hook or MCP server in isolation; a hook against a prepared or arbitrary JSON event
- **Chat** — talk to Claude Code from the panel: streaming, attachments, voice, artifact preview, model and effort picker, branching by editing a message, clickable answer options, search over the conversation body, feed pagination and conversation export to md/json
- **Several projects at once** — project tabs, with agents running in parallel and surviving tab switches; a project's dev server starts right from its tab (free port, auto-opened browser, status on the button, stop)
- **Search** — one global search line across rules, skills, hooks, scripts, permissions, variables, MCP and plugins (secret values are never revealed)
- **Change history** — a feed of configuration edits with a line-by-line diff over the backups; revert a whole file or a single change out of a backup
- **Analytics** — token spend and estimated cost, read from your local transcripts: an hourly heatmap, the cache share, export to CSV and JSON by model, project and session
- **Groups** — arbitrary sets of entities, switchable together; they nest inside one another, and member order is settable
- **Automations** — scenarios that compile down to ordinary hooks
- **AI assistant** — describe a rule or skill in words, get the form filled in
- **Command palette** — Ctrl/Cmd+K to jump into a section and run quick actions, keyboard shortcuts, a toast history; first-run onboarding and an accent colour of your choice
- **Configuration bundle** — export and import a set of rules, skills and hooks as one file
- **Help** — a walkthrough of every section with diagrams, in English and Russian
- **Live reload** — the panel follows file changes, including ones Claude Code makes itself
- **Backups** — every write is backed up and atomic; optional encryption of `.mcp-secrets.env` copies

</td></tr>
</table>

### Soft disable

Turning something off never deletes it. A disabled rule moves to a holding section of `CLAUDE.md`, a disabled skill moves to `skills-disabled/`, a disabled MCP server moves to an `mcpServersDisabled` key, and a disabled hook's command is kept in the panel's own state (it must not stay in `settings.json`, or Claude Code would keep running it). The text survives; only Claude Code's view of it changes. That is what makes bisecting a misbehaving setup practical.

A group switches off as a whole: every member goes dark at once and comes back when you switch it on. The group's mark is kept separately from the manual one, so a member you disabled individually will not spring back when the group returns, and a member of two groups only comes back once both have let go of it.

## How it works

There is no database. The panel is a view over the files Claude Code already reads, and edits go back to those same files.

```mermaid
flowchart LR
    subgraph browser["Browser · localhost:8888"]
        UI["React UI<br/>18 sections"]
    end

    subgraph server["Node server · 127.0.0.1:5178"]
        API["Fastify API"]
        WATCH["File watcher"]
        SAFE["Backup +<br/>atomic write"]
    end

    subgraph disk["Your disk"]
        CFG["~/.claude<br/>CLAUDE.md · settings.json<br/>skills/ · hooks/"]
        MCP["~/.claude.json<br/>MCP servers · account"]
        TR["~/.claude/projects<br/>transcripts"]
    end

    CLI["claude CLI"]

    UI <-->|"/api"| API
    API --> SAFE --> CFG
    API --> SAFE --> MCP
    API -->|read only| TR
    API -->|spawn| CLI
    CFG -.->|change| WATCH
    MCP -.->|change| WATCH
    WATCH -.->|"SSE /api/events"| UI

    style browser fill:#e8f0fe,stroke:#4285f4
    style server fill:#e6f4ea,stroke:#34a853
    style disk fill:#fef7e0,stroke:#fbbc04
```

Three things follow from that shape:

**Nothing is cached behind your back.** The panel is not the owner of the configuration — you and Claude Code edit those files too. A watcher (chokidar) sees changes and pushes them to the UI over SSE, so an edit made in your editor shows up in the panel without a refresh.

**Writes are defensive.** Every write goes through a backup into `~/.claude/claude-control/backups/` and lands atomically (write to a temp file, then rename), so an interrupted save cannot leave you with a half-written `settings.json`.

**Restart is honest.** Claude Code reads its configuration at startup. Almost every mutation returns `needsRestart: true`, and the UI says so, rather than pretending the change is already live.

### The AI features use your own subscription

The form assistant, the skill-structure generator and the chat all shell out to the `claude` CLI you already have installed and logged in. There is no API key to configure, and no key is stored anywhere — Claude Code's own credentials are used, by Claude Code.

## Where your data lives

Everything is under your home directory. The panel creates no files inside the repository.

| Path                                  | Access        | What it is                                                  |
| ------------------------------------- | ------------- | ----------------------------------------------------------- |
| `~/.claude/CLAUDE.md`                 | read / write  | Rules                                                       |
| `~/.claude/settings.json`             | read / write  | Hooks, permissions, env                                     |
| `~/.claude/settings.local.json`       | read / write  | Personal hooks, permissions and vars — tagged "local"       |
| `~/.claude/skills/`                   | read / write  | Skills                                                      |
| `~/.claude/skills-disabled/`          | read / write  | Disabled skills                                             |
| `~/.claude/hooks/`                    | read / write  | Hook scripts                                                |
| `~/.claude.json`                      | read / write  | MCP servers, account (note: _beside_ `.claude`, not inside) |
| `~/.claude/.mcp-secrets.env`          | read / write  | MCP secrets                                                 |
| `~/.claude/projects/`                 | **read only** | Transcripts — the source for chat and analytics             |
| `~/.claude/.credentials.json`         | **read only** | Copied into a sandbox so the CLI is logged in               |
| `~/.claude/claude-control/state.json` | read / write  | The panel's own state: groups, automations, settings        |
| `~/.claude/claude-control/backups/`   | write         | Timestamped backups                                         |
| `~/.claude-control/chats/`            | read / write  | Working folders for chats started in the panel              |
| `~/.claude-control/sandboxes/`        | read / write  | Temporary sandbox config and working dirs                   |

The last two sit outside `~/.claude` deliberately: Claude Code treats its own directory as protected and refuses to write there, so artifacts created during a chat would silently fail to appear.

Configuration root discovery, in order: the path set in the panel's Settings → the `CLAUDE_CONFIG_DIR` environment variable → `~/.claude`. If none resolves, the UI asks you for the path instead of guessing.

## The sandbox

The point of the sandbox is to answer "what does this rule actually do?" without making it your daily setup.

Claude Code reads everything from the directory named by `CLAUDE_CONFIG_DIR`. The sandbox builds a temporary directory, puts **only the thing under test** into it, and launches the CLI pointed at that directory.

```mermaid
flowchart TD
    PICK["Pick what to test<br/>rule · skill · hook · MCP server"] --> BUILD["Build a temp config dir"]
    BUILD --> COPY["Copy in: the selected items<br/>+ .credentials.json, so the CLI is logged in"]
    COPY --> DENY["Write deny rules:<br/>real ~/.claude is read-only,<br/>token files unreadable"]
    DENY --> RUN{"How to test?"}
    RUN -->|"hook / script"| PROBE["Event replay — no model<br/>9 fixtures, ~80 ms, free"]
    RUN -->|"MCP server"| TOOLS["Start it, list tools,<br/>call one for real"]
    RUN -->|"rule / skill"| CHAT["A real conversation —<br/>the only way to test these"]
    PROBE --> DROP["Everything deleted on close"]
    TOOLS --> DROP
    CHAT --> DROP

    style DENY fill:#fce8e6,stroke:#ea4335
    style DROP fill:#e6f4ea,stroke:#34a853
```

Measured in such a run: **30 tools instead of 165, zero MCP servers, and not one third-party hook fires.** The only thing carried over from the real directory is `.credentials.json` — without it the CLI answers "Not logged in". `.mcp-secrets.env` is never copied.

A second line of defence is written into the sandbox's own `settings.json`: `~/.claude/**` is denied for writing and the token files are denied for reading. Verified in practice — a prompt asking Claude to read `settings.json` and write `PROBE.txt` into `~/.claude` was refused on both counts, and no file appeared.

Hook and script testing needs no model at all. Nine prepared events (a harmless command, `rm -rf`, `git push`, a secret being written, a placeholder key, and so on) are replayed straight at the script, and the verdict is compared against what the fixture expects. It costs nothing and takes under a tenth of a second, so it is practical to run on every edit.

## Chat and parallel agents

Chat in the panel is not a separate bot and not a wrapper around the API. It launches the very same `claude` you use in the terminal, and the conversation stays in ordinary Claude Code transcripts. A conversation started in the terminal shows up in the panel, and the other way around.

What the panel adds on top of the CLI is concurrency. Each project opens in its own tab and runs its own process; switching tabs does not stop an agent.

```mermaid
flowchart LR
    subgraph tabs["Panel tabs"]
        HOME["Chats<br/>no project"]
        P1["Project A 🟢"]
        P2["Project B 🟡"]
        P3["Project C 🔴"]
    end

    subgraph runs["A process each"]
        R1["claude<br/>working"]
        R2["claude<br/>waiting for a reply"]
        R3["claude<br/>error"]
    end

    PANEL["Agents panel<br/>status · spend · stop"]

    P1 --> R1 --> PANEL
    P2 --> R2 --> PANEL
    P3 --> R3 --> PANEL
    PANEL -.->|"click a row"| P2

    style P1 fill:#e6f4ea,stroke:#34a853
    style P2 fill:#fef7e0,stroke:#fbbc04
    style P3 fill:#fce8e6,stroke:#ea4335
```

**The dot on a tab says what is happening.** Green — the agent is working; yellow — it asked a question and is waiting; red — an error, a rate limit, or a stall: if no events arrive for two minutes the run is treated as broken. A background agent that finishes or gets stuck on a question sends a notification, and clicking it opens that project.

**Edits are allowed by default, and the toggle remembers where you left it.** It used to reset on every reload, which made agents stall over nothing — so now it sticks, and switching to read-only is a deliberate act. Worth checking before you hand a task to an unfamiliar repository. If a run does stall, the header offers **Retry** and **Allow and continue**; the second one re-runs the same request with full access, bypassing both the toggle and the rules in the Permissions section.

**Spending is visible as it happens** — in tokens by default, because on a subscription dollars mean nothing. Switch it to money in the settings if you prefer.

The honest boundary: a run belongs to the server, not to the tab. Closing the tab or pressing F5 only detaches the listener — the agent keeps working, and on return the panel picks the running jobs back up; one that finished while the tab was closed comes back to the feed within a grace minute, and after that stays in the transcript. The session's spend counter is likewise counted on the server and survives a reload. The real boundary is restarting the server itself: the run registry lives in its memory. You answer an agent's question either in text or by clicking one of the offered options.

## CLIs other than Claude

The panel grew out of Claude Code and stays its tool: **the Claude provider is active by default, and with it everything is available.** But the neighbouring agentic CLIs keep their configuration the same way — an instructions file, MCP servers, environment variables, an approval policy — and the panel edits those files directly, each in its native format.

What you get is one UI across several tools. You no longer have to remember that Codex keeps MCP in TOML, Gemini in JSON, OpenCode under a different key in a different shape, and that Aider writes environment variables as a YAML list. The panel shows the same forms it shows for Claude and writes what that CLI actually reads.

### Choosing a provider

**Settings → Configuration provider.** The panel also checks which CLIs are actually installed: each carries an "installed" / "config found" / "not found" badge plus a "recommended" hint. The same step appears in the first-run onboarding, and it is optional.

Detection is **a hint, never a decision**: the provider never switches by itself, the default stays `claude`, and the panel writes only on an explicit action of yours. If the active provider's CLI is not on `PATH`, the panel says so without breaking the section: configuration is just files and can be edited before the CLI is installed. The assistant, however, needs either the CLI or a key — without both it offers a modal with instructions.

After switching, the sidebar changes: exactly what that CLI supports remains.

### The map: section × provider

**✅ works** · **🛠 in development** — the section is visible with a badge, opens a placeholder and neither reads nor writes · **— unsupported** — the section is hidden entirely.

|                                     | Claude<br>_verified_ | Codex | Gemini | Cursor | OpenCode | Aider |
| ----------------------------------- | :------------------: | :---: | :----: | :----: | :------: | :---: |
| Global instructions<sup>1</sup>     |          ✅          |  ✅   |   ✅   |  ✅ *  |    ✅    | ✅ *  |
| MCP servers<sup>2</sup>             |          ✅          |  ✅   |   ✅   |   ✅   |    ✅    |   —   |
| Environment variables<sup>3</sup>   |          ✅          |  ✅   |   ✅   |   —    |    —     |  ✅   |
| Permissions / approvals<sup>4</sup> |          ✅          |  ✅   |   ✅   |   —    |    ✅    |   —   |
| Chat / assistant<sup>5</sup>        |          ✅          |  🧪   |   🧪   |   —    |    🧪    |  🧪   |
| Rules (`## RULE:` sections)         |          ✅          |   —   |   —    |   —    |    —     |   —   |
| Skills<sup>10</sup>                 |          ✅          |   —   |   —    |   —    |    ✅    |   —   |
| Hooks<sup>8</sup>                   |          ✅          |   —   |   —    |   —    |    ✅    |   —   |
| Scripts<sup>6</sup>                 |          ✅          |  ✅   |   ✅   |   ✅   |    ✅    |  ✅   |
| Plugins<sup>9</sup>                 |          ✅          |   —   |   —    |   —    |    ✅    |   —   |
| Projects<sup>7</sup>                |          ✅          |  ✅   |   ✅   |   ✅   |    ✅    |  ✅   |
| Analytics (tokens, cost)            |          ✅          |   —   |   —    |   —    |    —     |   —   |
| Sandbox                             |          ✅          |   —   |   —    |   —    |    —     |   —   |

**Overview, Search, Groups, History, Settings and Help are always there** — those are the panel's own sections and do not depend on the provider. History and search do follow the active provider's files: backups of a foreign config are stored under their own name and never mix with Claude's.

What the footnotes stand for — and why each status is what it is:

1. **Instructions** — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`. Plain markdown, so the section ports one to one. For **Cursor** the model is different: the global rules are not a file but a **directory**, `~/.cursor/rules/*.mdc`, where every file is one rule with YAML frontmatter (`description`, `globs` — file patterns separated by commas, `alwaysApply` — attach to every conversation) and a markdown body; nested subdirectories are supported. The section became a manager for that directory: list, create, edit and delete rules; the three frontmatter fields are separate form fields, the rule text is its own field and is written back verbatim, while comments and your own frontmatter keys stay in place. A plain `.md` in the rules directory is ignored by Cursor — the panel lists such files separately and never edits them. A rule path must resolve inside the directory: `..`, absolute paths, a foreign extension and symlinks are rejected on read, write and delete alike. For **Aider** the model is different too: it has no single instructions file — context files are declared by the `read` option in `.aider.conf.yml` (`read: [CONVENTIONS.md, anotherfile.txt]`). The section therefore manages that **list of references**: add a file, remove one, change the attach order; the list is written through the `yaml` Document API, so comments and every other key of the config stay intact. On top of that you can open and edit the **contents** of an already listed file — but only if it exists: the panel never creates files that are not there, and never opens what the config does not reference.
2. **MCP** — `~/.codex/config.toml` (`[mcp_servers]`), `~/.gemini/settings.json`, `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json` (the `mcp` key, with its own `local`/`remote` shape). **Aider** has no MCP server setting in its options reference — this is not "we did not get to it" but nothing to configure.
3. **Environment** — `[shell_environment_policy.set]` in Codex's `config.toml`, the `set-env` key in Aider's `.aider.conf.yml` (the global `~/.aider.conf.yml` and the per-project one in the repository root), and a plain `.env` file for Gemini (global `~/.gemini/.env` and per-project `<project>/.gemini/.env` — its `settings.json` indeed has no "set a variable" map). The `.env` file is edited line by line: only the lines of the affected variables change, while comments, blank lines and ordering stay as they were. **OpenCode** has no such section and will not get one: per its documentation it only substitutes `{env:VARIABLE}` inside `opencode.json`, i.e. reads the process environment that is already set, and it does not load a `.env` file of its own (that is an open feature request upstream, not a shipped feature). The panel will not create a file nobody reads — hence the section is hidden rather than marked "in development".
4. **Permissions** — for Codex these are two root keys of `config.toml`: `approval_policy` and `sandbox_mode`. **Gemini** uses a different model, kept in `settings.json`: the approval mode `general.defaultApprovalMode` (`default` — ask every time, `auto_edit` — file edits without prompts, `plan` — read-only) plus two tool lists, `coreTools` (what is allowed) and `excludeTools` (what is blocked, and it wins). The panel never writes the `yolo` mode: per Gemini's docs it is a command-line flag only, and in `settings.json` it makes the CLI fail on startup. **OpenCode** uses a third model — the `permission` key of `opencode.json` (global and per-project): every tool gets its own level, `allow` (no prompt), `ask` (confirm) or `deny` (block); the documented tools are `edit` (file edits), `bash` (shell commands) and `webfetch` (network fetches). For `bash`, a **list of command patterns** can replace the single level — e.g. `*` → `ask`, `git *` → `allow`, `git push *` → `deny`; the panel shows that list as "pattern + level" rows and can edit it. Anything inside `permission` the panel does not manage (other tool names, or the advanced form where it is not supported) is **kept as is** and shown read-only. Per-agent permission overrides (`agent.*`) are not touched at all.
5. **Chat** — with Claude this is the full chat: streaming, attachments, branching, parallel agents, history. The 🧪 for Codex, Gemini, OpenCode and Aider means a **basic experimental assistant**: one question, one answer, no streaming and no attachments (`codex exec`, `gemini -p`, `opencode run "<prompt>"`, `aider --message`). The prompt is always passed as a separate argv element, never interpolated into a shell string; for OpenCode it is a positional argument of the `run` subcommand (this CLI accepts no stdin). Aider's and OpenCode's assistants are **built from the documentation and have not been exercised live** — those CLIs are not installed on the development machine, so the first real run is worth eyeballing. **Cursor** has no model API of its own, so the assistant is unavailable.
6. **Scripts** — this is a section of **the panel itself**: your own files (`.mjs`, `.sh`, `.ps1`, `.py`) in the `hooks/` folder of the panel directory. Neither the provider's CLI nor its config format is involved, so the section works everywhere. Exactly two things in it are Claude-specific and stay hidden for the rest: the **sandbox** (it boots an isolated Claude Code) and the **"called by a hook"** flag (other CLIs have no hooks). The code scaffolds are swapped too: without hooks you get plain standalone scripts instead of Claude hook skeletons.
7. **Projects** — the project registry is shared, but the selected project's config differs per provider. For **Claude** it is the same rich set as before: `CLAUDE.md`, `.mcp.json` and permissions in `.claude/settings.json`. For the rest it is whatever their CLI documents: project instructions (`AGENTS.md` for Codex and OpenCode, `GEMINI.md` for Gemini) and the project's MCP servers (`.codex/config.toml`, `.gemini/settings.json`, `opencode.json`, `.cursor/mcp.json`); for **Gemini** the project's environment variables (`.gemini/.env`) and permissions (`.gemini/settings.json`) come on top, and for **OpenCode** the project's permissions live in the same `opencode.json` (the `permission` key). **Cursor**'s project level is the same rules directory, only inside the project: `<project>/.cursor/rules/*.mdc`, with the same path safety. **Aider**'s project level is `<project>/.aider.conf.yml`: per its docs the config is looked up in the home directory, **in the git repository root** and in the current directory (loaded in that order, later wins). Inside a project you get the same things as globally: the `read` list of attached files and the `set-env` variables. Edits go through the same adapters as the global level: other keys and comments stay intact, a backup is made before every write, and any path leaving the project directory is rejected.

8. **Hooks** — for **Claude** this is its own model: `PreToolUse`/`PostToolUse` events with tool matchers and shell commands in `settings.json`. **OpenCode** organises them fundamentally differently, and the section is built for its model: the `experimental.hook` key of `opencode.json` (global and per-project). There are exactly two events. **"File edited"** (`file_edited`) maps a file pattern to a list of actions — edit a file matching `*.ts` and `prettier --write` runs. **"Session completed"** (`session_completed`) is simply a list of actions to run when work finishes. A command is given as a **list of arguments**, not a shell string: the program first, then its arguments one per field, so a space inside an argument is safe while "`prettier --write`" as one string will not work — the panel shows it as separate fields precisely so this cannot be confused. Only that key is edited: the rest of the file, other `experimental` keys and unknown events are preserved and shown read-only. **Important caveat:** the key lives under `experimental`, which OpenCode itself declares unstable ("may change or be removed without notice"), and on top of that the current configuration documentation page does not mention hooks at all while the published configuration schema has no `hook` key. The panel says so plainly in the UI and does not present the section as a settled feature — verify it against your CLI version.
9. **Plugins** — for **Claude** these are the panel's own extensions and marketplaces (a wrapper around `claude plugin`). For **OpenCode** these are plugins of its own CLI, and there are two documented ways, both supported. First, **files** in JS/TS inside the directory OpenCode loads at startup: `~/.config/opencode/plugins/` globally and `<project>/.opencode/plugins/` per project. The panel manages them as a file manager: list (including subdirectories), read, create, edit, delete; a backup is made before every write and before every delete, and the directory is created only on an explicit save. A path must resolve inside the directory: `..`, absolute and UNC paths, foreign extensions and symlinks are rejected on read, write and delete alike. Second, the **list of npm packages** under the `plugin` key of `opencode.json`; both plain and scoped packages such as `@org/name` are supported. The panel cannot install packages — the CLI does that; it only edits the list. Entries of the "name + options object" form are allowed by the configuration schema, but their shape is undocumented — the panel keeps such entries as is and shows them read-only.
10. **Skills** — for **Claude** this is its rich section: a folder per skill with a file tree, enable/disable by moving into `skills-disabled/`, groups, a template library. For **OpenCode** the concept is the same — a folder with a `SKILL.md` and YAML front matter — but the directories and field set are its own: `~/.config/opencode/skills/<name>/SKILL.md` globally, `<project>/.opencode/skills/<name>/SKILL.md` per project. The panel edits the two required front-matter fields — `name` and `description`; the `license`, `compatibility`, `metadata` and any foreign fields it keeps as is and shows read-only. The name must equal the folder name and follow the rules (1–64 characters, lowercase letters, digits and single hyphens, no hyphen at the edges and no `--`); this is checked before writing. A path must have the form `<name>/SKILL.md` inside the directory — `..`, absolute paths and symlinks are rejected on read, write and delete alike; the directory and folders are created only on an explicit save. Worth knowing: OpenCode also loads skills from `~/.claude/skills` and `~/.agents/skills`, so your already configured Claude skills work in it without moving anything — the panel says so and never writes into those directories (the Claude skills section manages them).

Claude is marked **verified** — its path has been exercised live and is covered by tests. The rest are **experimental**: the formats come from each CLI's documentation, are covered by round-trip tests and are never guessed, but for every foreign format the panel writes for the first time it is worth eyeballing that first real write (see [LIMITATIONS.md](LIMITATIONS.md)).

### Your subscription outranks a paid API

The panel's assistant picks what to run in a fixed order — **free-for-you first, paid last**:

1. **The provider's CLI that you are already logged into.** If `claude`, `codex` or `gemini` is on `PATH`, the panel calls it. That is your subscription: nothing extra to pay, no key needed.
2. **An API key only if there is no subscription.** The key is asked for when the CLI is not found, and it serves as the fallback path, not the main one.
3. **Otherwise a modal with instructions**: how to log into that provider's CLI, and where to get a key if logging in is not an option.

That order is exactly this way and is pinned by tests: a stored key does not override the CLI.

Any key you do enter is stored encrypted (AES-256-GCM) in `claude-control/provider-keys.enc`; the passphrase is a machine-local file with `0600` permissions. Only a mask like `sk-…1234` ever leaves the server. Keys never reach the logs, the backups, the history feed, the global search or the bundle export — there is a dedicated test that walks every provider to prove it.

### What protects a foreign config

Somebody else's `config.toml` is not our file, and it is handled more carefully than our own:

- **A backup before every write, and the write is atomic.** A provider's backups are stored under their own name (`<provider>-<file>`), so they never mix with Claude's and cannot be restored on top of them.
- **Formats come from the documentation, not from memory.** Every adapter follows the official configuration reference of its CLI.
- **Validation before writing, plus round-trip.** The file is read, changed and reassembled; the result is compared against what was read. If it does not match, nothing is written.
- **Surgical edits.** In Codex only the region of `config.toml` that is being changed is touched: comments, profiles, key order and everything the edit does not concern stay byte for byte. Comments survive writes in Aider's YAML too. The file's shape is preserved: line endings (`CRLF`/`LF`) stay as they were, and a BOM is stripped on read and put back on write.
- **Fail-closed.** An unfamiliar, broken or unexpectedly shaped file is not an invitation to "write something plausible": the section returns an error and stays read-only. The same rule covers an unsupported capability: the section simply is not there.
- **Documented directory overrides are honoured** — `CODEX_HOME` moves all of Codex's paths, `XDG_CONFIG_HOME` moves OpenCode's config directory, and `OPENCODE_CONFIG` moves the `opencode.json` file itself (MCP and permissions follow it). Undocumented variables are not invented.

## Security

The threat model is worth stating plainly, because this tool sits on sensitive files by design: it has full read and write access to `~/.claude`, including `.credentials.json` and `.mcp-secrets.env`, and it can start processes. It is a single-user tool for your own machine — not a multi-user service, and not something to expose.

Within that model, here is what was verified rather than assumed.

### Your keys do not reach git

Checked by dry-running the commit that a contributor would actually make:

- `git add -An --all` stages only source files and notes — no configuration, no credentials.
- History is clean: no `.env`, credential, key or token file has ever been added.
- **The application writes nothing inside the repository.** Every write path resolves under `~/.claude` or `~/.claude-control`; there are no writes relative to `process.cwd()` in the server at all.

One consequence worth knowing: chat attachments now land in the panel's own folder rather than the conversation's working directory. Before, a chat started inside a project could drop an uploaded file straight into your working tree, where the next `git add -A` would pick it up.

### Nothing is sent anywhere

- **No telemetry, no analytics, no error reporting.** Zero references to Sentry, PostHog, Google Analytics, Mixpanel, Segment and the rest — in the code and in the lockfile alike. No external CDN, font or script in the page.
- The **Analytics** section reads your local transcripts and computes everything in memory. It is a log parser, not a reporting client.
- The only outbound requests the server makes go to an MCP server's URL that you configured yourself: an MCP protocol handshake, to see whether it answers and what tools it offers.
- The frontend talks only to its own API on a relative `/api` path.
- Secrets never appear in command-line arguments — prompts go in over stdin, tokens through the environment — so they are not visible in `ps` or Task Manager. There is no logging of secrets anywhere.

Indirect traffic exists and is expected: the `claude` CLI talks to the Anthropic API, `claude plugin` fetches marketplace repositories, and MCP servers do whatever they do. Those are the tools you are already running; the panel just launches them.

### The API is locked to your own UI

The server binds to `127.0.0.1` only, so nothing on your network can reach it. That alone is not enough, though — a request from a page open in _your_ browser already comes from inside the loopback interface. So:

- **CORS is restricted to the panel's own origin** (`localhost:8888` / `127.0.0.1:8888`). Any other origin gets a 403 before the request reaches a route handler.
- A `Sec-Fetch-Site: cross-site` request is rejected too, which covers the forms and image tags that can be sent cross-origin without CORS permission at all.
- Values that end up as CLI arguments (session id, model, chat name, plugin id) are validated against an allowlist rather than escaped, because quoting rules under `cmd.exe` cannot be relied on.

Verified against a live server: a request carrying `Origin: https://evil.example.com` is refused for reading configuration, for reading secrets, and for installing a hook, while the panel itself continues to work normally.

> [!IMPORTANT]
> Do not change the bind address to `0.0.0.0`, put the API behind a reverse proxy or tunnel, or publish the port out of a container. The API has no authentication by design — anyone who can reach it can read your tokens and register a hook, and a hook is a command Claude Code will run.

### Things to know

- Sandboxes under `~/.claude-control/sandboxes/` contain a copy of `.credentials.json` and any MCP server `env` values in plain text. They are removed when you close the sandbox, and any left behind by a crash are swept on the next server start: the sandbox registry lives in memory, so whatever is still on disk at startup belongs to nobody. Folders younger than a minute are left alone, so two servers starting at once do not clear each other's work.
- Backups in `~/.claude/claude-control/backups/` include copies of `.mcp-secrets.env` in plain text. Same directory permissions as the original, no encryption.
- `HookProbe.ts` contains a synthetic, non-functional `glpat-…` string. It is bait used to check that a secret-blocking hook actually fires. It is not a leak, but GitHub secret scanning will flag it.

## Quick start

**Requirements:** Node.js 22.6+ (for TypeScript type stripping), pnpm 10+, and the `claude` CLI installed, logged in, and on your `PATH`.

```bash
pnpm install
pnpm dev
```

The panel opens at **http://localhost:8888**. The API runs on **127.0.0.1:5178**.

Anything unexpected — a port in use, an empty configuration directory, plugins not listing — is covered in **[SETUP.md](SETUP.md)**, along with where `.claude` lives on each OS and how to get the panel working again.

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

⚠️ **Running agents** is a best-effort panel: agents are matched by their command line, because a CLI installed through npm runs under the name `node`, not `claude`. If listing processes is not permitted, the section simply stays empty.

Sandbox fixtures use example paths in the style of whichever system the panel runs on, and the filesystem MCP preset fills in your home directory.

## Development

```
apps/
  server/     Fastify API · TypeScript run directly by Node, no build step
  web/        React 19 + Vite · FSD layout, SCSS modules
packages/
  contracts/  Shared zod schemas and types
tools/qa/     Playwright scripts — screenshots, layout audit, flow checks
```

| Command           | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `pnpm dev`        | Server and frontend together                                 |
| `pnpm check`      | The full gate: format, types, lint, module boundaries, build |
| `pnpm type-check` | TypeScript across all packages                               |
| `pnpm lint`       | ESLint                                                       |
| `pnpm depcruise`  | FSD layer boundaries                                         |
| `pnpm qa:setup`   | Install the Chromium build the QA scripts need (once)        |

QA scripts run against a live panel: `node tools/qa/screenshot.mjs light`, `node tools/qa/audit-layout.mjs`, and so on. Point them elsewhere with `APP_URL`.

The frontend follows Feature-Sliced Design, and the layer boundaries are machine-enforced by dependency-cruiser — imports may only go downward, and cross-feature imports are rejected.

The server has no build step: Node runs the TypeScript sources directly via `--experimental-strip-types`. That is why the Node floor is 22.6 and why constructs needing real compilation (parameter properties, enums) are avoided.

## Known limitations

The full section-by-section breakdown is in [LIMITATIONS.md](LIMITATIONS.md): what is limited, why, and whether it is worth waiting for.

- **Restart required.** Claude Code loads its configuration at startup, so most changes only take effect after you restart it. The UI marks these.
- **Plugins depend on the CLI.** Everything on that page shells out to `claude plugin`; if the CLI cannot reach a marketplace, the panel shows you its raw output rather than inventing a friendlier error.
- **Analytics costs are indicative.** On a subscription you are not billed per token, so treat the number as relative volume, not money owed. The price list is pulled from the Anthropic site and shown in Settings; it excludes discounts, batch rates and negotiated account terms.
- **A restore works by whole file or by single change.** Backups are listed in Settings: one click rewrites the entire file, or you can return just one change (a hunk) out of a backup. The state before the restore is itself saved as a fresh copy.
- **Chat runs live in server memory.** Closing the tab or reloading the page does not touch the agent: the run belongs to the server, and on return the panel picks the running ones back up (one that finished while the tab was closed returns to the feed within a grace minute, and after that only in the transcript). The session's accumulated spend is likewise counted on the server and survives F5. The real boundary is restarting the server: the registry of running processes is held in its memory, so that ends everything.
- **The list of created files exists only for chats outside a project.** Inside a real repository it is deliberately not shown.
- **Editing a hook changes its id.** The id is derived from the content, so a rewritten command is a different hook: a saved link to it stops opening, and its group membership has to be set again.

## License

Not yet specified.
