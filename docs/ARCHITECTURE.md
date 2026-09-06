# How it works

The two halves of the panel, the source of truth on disk, and the sandbox where a change is tested before it becomes your daily setup.

🇷🇺 [Русская версия](ARCHITECTURE.ru.md) · 📖 [What this project is](../README.md) · 🔒 [Security](SECURITY.md) · 🧑‍💻 [Development](DEVELOPMENT.md)

---

## Contents

- [How it works](#how-it-works)
- [Where your data lives](#where-your-data-lives)
- [The sandbox](#the-sandbox)

---

## How it works

There is no database. The panel is a view over the files Claude Code already reads, and edits go back to those same files.

```mermaid
flowchart LR
    subgraph browser["Browser · localhost:8888"]
        UI["React UI<br/>20 sections"]
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

Three things follow:

- **Nothing is cached behind your back.** You and Claude Code edit those same files; a watcher (chokidar) pushes changes to the UI over SSE, so an edit made in your editor shows up without a refresh.
- **Writes are defensive.** A backup into `~/.claude/claude-control/backups/`, then an atomic write through a temp file — an interrupted save cannot leave a half-written `settings.json`.
- **Restart is honest.** Claude Code reads its configuration at startup, so almost every mutation returns `needsRestart: true` and the UI says so.

The AI features (form assistant, skill generator, chat) shell out to the `claude` CLI you already have installed and logged in. No API key to configure, none stored anywhere.

## Where your data lives

Everything is under your home directory. The panel creates no files inside the repository.

| Path                                  | Access        | What it is                                                  |
| ------------------------------------- | ------------- | ----------------------------------------------------------- |
| `~/.claude/CLAUDE.md`                 | read / write  | Rules                                                       |
| `~/.claude/settings.json`             | read / write  | Hooks, permissions, env                                     |
| `~/.claude/settings.local.json`       | read / write  | The same, personal — tagged "local"                         |
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

The last two sit outside `~/.claude` deliberately: Claude Code treats its own directory as protected and refuses to write there, so chat artifacts would silently fail to appear.

Configuration root discovery, in order: the path set in the panel's Settings → `CLAUDE_CONFIG_DIR` → `~/.claude`. If none resolves, the UI asks instead of guessing.

## The sandbox

Answering "what does this rule actually do?" without making it your daily setup.

Claude Code reads everything from the directory named by `CLAUDE_CONFIG_DIR`. The sandbox builds a temporary directory, puts **only the thing under test** into it, and launches the CLI pointed at that directory.

```mermaid
flowchart TD
    PICK["What to test<br/>rule · skill · hook · MCP"] --> BUILD["Build a temp config dir"]
    BUILD --> COPY["Copy in the selection<br/>+ .credentials.json, so the CLI is logged in"]
    COPY --> DENY["Deny rules: real ~/.claude<br/>read-only,<br/>token files unreadable"]
    DENY --> RUN{"How to test?"}
    RUN -->|"hook / script"| PROBE["Event replay — no model<br/>9 fixtures, ~80 ms, free"]
    RUN -->|"MCP server"| TOOLS["Start it, list<br/>and call tools"]
    RUN -->|"rule / skill"| CHAT["A real conversation"]
    PROBE --> DROP["Everything deleted on close"]
    TOOLS --> DROP
    CHAT --> DROP

    style DENY fill:#fce8e6,stroke:#ea4335
    style DROP fill:#e6f4ea,stroke:#34a853
```

Measured in such a run: **30 tools instead of 165, zero MCP servers, and not one third-party hook fires.** The only thing carried over from the real directory is `.credentials.json` — without it the CLI answers "Not logged in"; `.mcp-secrets.env` is never copied.

A second line of defence is the sandbox's own `settings.json`: `~/.claude/**` denied for writing, token files denied for reading. Verified in practice — a prompt asking Claude to read `settings.json` and write `PROBE.txt` into `~/.claude` was refused on both counts, and no file appeared.

Hooks and scripts are tested with no model at all: nine prepared events (a harmless command, `rm -rf`, `git push`, a secret being written, and so on) are replayed straight at the script and the verdict compared against what the fixture expects. Free, under a tenth of a second — practical to run on every edit.
