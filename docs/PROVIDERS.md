# Providers: format details

The footnotes of the "section × provider" map, which lives in
[README.md](../README.md#clis-other-than-claude). Per row of that map: where the file is, what the
panel edits in it, what it leaves alone, and why the status is what it is. All of it from each
CLI's official documentation and from the adapter code.

The tools that work on top of providers (moving an environment, the model catalog, the
on-your-machine check, the write preview, comparison and the format check against schemas) live in
[Providers: panel-side tools](PROVIDER-TOOLS.md).

🇷🇺 [Русская версия](PROVIDERS.ru.md) · 📖 [What this project is](../README.md) ·
🚫 [What the panel does not do](LIMITATIONS.md) · 🔧 [Setup and troubleshooting](SETUP.md)

---

## 1. Global instructions

Plain markdown, so the section ports one to one: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`, `~/.qwen/QWEN.md`, `~/.config/opencode/AGENTS.md`,
`~/.config/goose/.goosehints`, `~/.kimi-code/AGENTS.md` (the directory moves with `KIMI_CODE_HOME`).

**Goose — the same plain file, a different path on Windows.** Hints live in `.goosehints` next to
the config, and that config is not under `~/.goose`: macOS and Linux use `~/.config/goose/`, Windows
uses `%APPDATA%\Block\goose\config\`. Per project the file is `<project>/.goosehints`.

**Cursor — a directory, not a file.** `~/.cursor/rules/*.mdc`, every file one rule with YAML
frontmatter (`description`, `globs` — comma-separated file patterns, `alwaysApply`) and a markdown
body; nested subdirectories supported. The section is a manager for that directory: list, create,
edit, delete; the three frontmatter fields are separate form fields, the body is written back
verbatim, comments and your own frontmatter keys stay. A plain `.md` is ignored by Cursor — such
files are listed separately and never edited. A rule path must resolve inside the directory: `..`,
absolute paths, a foreign extension and symlinks are rejected on read, write and delete alike.

**Continue — no global instructions at all.** Only the PROJECT rules directory
(`<project>/.continue/rules/*.md`) is documented; the `rules:` key of `config.yaml` is
heterogeneous — inline rule strings mixed with hub references (`uses:`). The panel refuses to guess
which of those is "global instructions", so the section is hidden rather than marked "in
development". Project rules are full-featured: the same directory manager as Cursor's, but the
extension is `.md` and Continue's own frontmatter keys (`name`, `globs`, `alwaysApply`, `regex`) are
preserved. A rule file without frontmatter stays read-only.

**Aider — a list of references.** No single instructions file: context files are declared by the
`read` option in `.aider.conf.yml` (`read: [CONVENTIONS.md, anotherfile.txt]`). The section manages
that list — add, remove, reorder — through the `yaml` Document API, so comments and every other key
stay intact. The contents of a listed file can be edited too, but only if it exists: the panel
never creates missing files and never opens what the config does not reference.

## 2. MCP servers

`~/.codex/config.toml` (`[mcp_servers]`), `~/.gemini/settings.json`, `~/.qwen/settings.json`,
`~/.cursor/mcp.json`, `~/.config/opencode/opencode.json` (the `mcp` key, with its own
`local`/`remote` shape).

**Continue — the only LIST.** In `~/.continue/config.yaml` the `mcpServers` key is not a
"name → entry" map but an array, with each entry's name INSIDE it as the `name` field. Transport
comes from `type` (`stdio` by default, `sse`, `streamable-http`), a remote server's headers live in
`requestOptions.headers`. Only that block is edited: every other key of the file (models, rules,
context) and every comment outside the block survive, and unmodelled entry fields (`cwd`, timeouts,
keys) are carried over by value. A new remote server gets `streamable-http` (the primary one per the
docs), while an existing `sse` is never rewritten. The separate block files
`~/.continue/mcpServers/*.yaml` are left alone; the project-level MCP is
`<project>/.continue/mcpServers/mcp.json`.

**Goose — servers among the CLI's own extensions.** In `config.yaml` the `extensions` key is a
"name → entry" map where external MCP servers sit next to **built-in extensions of Goose itself**
(`developer`, `memory`, …). The entry kind comes from `type`: the panel treats `stdio`
(`cmd` + `args` + `envs`), `sse` and `streamable_http` (address in `uri`, headers in `headers`) as
servers; everything else (`builtin`, `platform`, `frontend`, `inline_python`) is not shown, is not
editable, and any write that would land on top of such an entry is refused — a built-in cannot be
overwritten, renamed onto, or deleted through the panel. A new entry gets `enabled: true` (without
it Goose will not start the server), an existing `enabled: false` is left as the user set it, and a
new remote server gets `streamable_http` while an existing `sse` is never rewritten. Other keys of
the file (provider, model, `GOOSE_MODE`) and comments outside the edited entry survive; comments
INSIDE an entry being edited do not — it is rebuilt from values so that unmodelled fields
(`timeout`, `cwd`, `env_keys`, `bundled`, `available_tools`) can be carried over intact.

**Kimi Code — MCP in a SEPARATE file.** Not in `config.toml` but in `~/.kimi-code/mcp.json`
(`config.toml` keeps only the MCP timeouts). The shape is the usual `mcpServers` map with a remote
server's address in `url`. The project file is `<project>/.kimi-code/mcp.json`. Unmodelled entry
fields (`enabled`, timeouts, tool filters) are carried over by value.

**Aider** has no MCP setting in its options reference — not "we did not get to it", but nothing to
configure.

## 3. Environment

| CLI       | Where                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| Codex     | `[shell_environment_policy.set]` in `config.toml`                               |
| Aider     | the `set-env` key in `~/.aider.conf.yml` and in the project's `.aider.conf.yml` |
| Gemini    | `.env` — global `~/.gemini/.env`, per-project `<project>/.gemini/.env`          |
| Qwen Code | `.env` — global `~/.qwen/.env`, per-project `<project>/.qwen/.env`              |
| Continue  | `.env` — global `~/.continue/.env`, per-project `<project>/.continue/.env`      |

Gemini's `settings.json` indeed has no "set a variable" map. The `.env` file is edited line by
line: only the lines of the affected variables change, comments, blank lines and ordering stay.

**Goose has no such section either.** It has no `.env` of its own: keys are stored in the OS keyring
or in `secrets.yaml`, and secrets are not something the panel keeps. Hidden rather than marked "in
development".

**Kimi Code has no such section.** It reads no `.env` of its own: provider keys sit right in
`config.toml` (`[providers.*]`), and the panel writes no secrets into a foreign config.

**OpenCode has no such section and will not get one.** Per its documentation it only substitutes
`{env:VARIABLE}` inside `opencode.json`, i.e. reads the process environment that is already set,
and loads no `.env` of its own. The panel will not create a file nobody reads — hence hidden rather
than marked "in development".

## 4. Permissions / approvals

- **Codex** — two root keys of `config.toml`: `approval_policy` and `sandbox_mode`.
- **Gemini** — `settings.json`: the mode `general.defaultApprovalMode` (`default` — ask every time,
  `auto_edit` — file edits without prompts, `plan` — read-only) plus the tool lists `coreTools`
  (allowed) and `excludeTools` (blocked, and it wins). The `yolo` mode is never written: per the
  docs it is a command-line flag only, and in `settings.json` it makes the CLI fail on startup.
- **Qwen Code** — `settings.json` too, but with keys of its OWN despite being a Gemini fork: the
  mode `tools.approvalMode` (`default`, `plan`, `auto-edit`, `auto`, `yolo`) plus three rule lists
  `permissions.allow` (run without asking), `permissions.ask` (always confirm) and
  `permissions.deny` (block; wins over the rest and holds even in autonomous modes). A rule is a
  tool with an optional specifier: `Bash(git push *)`, `Read(/src/**)`. Here the panel DOES write
  `yolo` — for Qwen it is a documented settings-file value, not a CLI flag only. The deprecated
  `tools.core` / `tools.allowed` / `tools.exclude` are never written (the docs migrate them into
  `permissions.*`) but are preserved if the file already has them.
- **Continue** — a SEPARATE file
  `~/.continue/permissions.yaml` with three top-level lists — `allow` (run immediately), `ask`
  (confirm) and `exclude` (hide the tool from the agent). There is no mode switch at all. A rule is
  a string such as `Read(**)` or `Bash(git status)`. An empty list removes its key; comments and
  other keys of the file stay. Per the docs these permissions apply to headless runs of the `cn`
  CLI — the interactive mode asks on its own.
- **Cursor** — the `permissions` key in `~/.cursor/cli-config.json` (the project file has a
  different name — `<project>/.cursor/cli.json` — and holds permissions only) and exactly TWO
  lists: `allow` (run without asking) and `deny` (blocked). This model has neither a mode switch
  nor an "ask" list: anything in neither list the CLI asks about itself, and `deny` beats `allow`.
  Rule forms are `Shell(command)`, `Read(path)`, `Write(path)`, `WebFetch(domain)`,
  `Mcp(server:tool)`, with globs `*`, `**`, `?` allowed inside. The panel edits only the
  `permissions` key: the version, editor settings and everything else in the same file stay
  untouched, and an empty list removes its own key.
- **Goose** — the shortest model of the eight: ONE root scalar of `config.yaml`, `GOOSE_MODE`
  (settings keys of this CLI are named like environment variables). Documented values: `auto` (acts
  without asking), `approve` (confirm every action), `smart_approve` (confirm the risky ones) and
  `chat` (talk only, no tools). No rule lists exist at all. Per-tool permissions Goose keeps in a
  separate `permission.yaml` — that format has not been worked through, so the panel does not touch
  it; `secrets.yaml` and the OS keyring are not touched either.
- **Kimi Code** — the second TOML model after Codex, and it has two parts at once: the root scalar
  `default_permission_mode` (`manual` — always ask, `auto` — the agent decides, `yolo` — never ask)
  and an ORDERED array of tables `[[permission.rules]]`, each with exactly `decision`
  (`allow` / `ask` / `deny`) and `pattern` (`Read`, `Bash(git push*)`, `mcp__server__tool`). Order
  matters — rules are checked top to bottom. Any foreign field inside `[permission]` or inside a
  rule turns the section read-only: regenerating such a block would drop someone else's data. Every
  other key of `config.toml` (providers, models, hooks, MCP timeouts) stays byte for byte.
- **OpenCode** — the `permission` key of `opencode.json` (global and per-project): each tool gets
  `allow` / `ask` / `deny`; the documented tools are `edit`, `bash` and `webfetch`. For `bash` a
  list of command patterns can replace the single level (`*` → `ask`, `git *` → `allow`,
  `git push *` → `deny`), edited as "pattern + level" rows. Anything else inside `permission` is
  kept as is and shown read-only; per-agent overrides (`agent.*`) are not touched at all.

## 5. Chat / assistant

With Claude this is the full chat: streaming, attachments, branching, parallel agents, history.

🧪 for Codex, Gemini, Qwen Code, Continue, Goose, Kimi Code, OpenCode and Aider means a **basic assistant**:
one question, one answer, no streaming and no attachments (`codex exec`, `gemini -p`, `qwen -p`,
`cn -p`, `goose run --no-session -t "<prompt>"`, `kimi -p`, `opencode run "<prompt>"`,
`aider --message`). The
prompt is always a separate argv element, never interpolated into a shell
string; for OpenCode it is a positional argument of the `run` subcommand (this CLI accepts no
stdin). Goose is asked for a single answer explicitly: `run` with `--no-session` leaves no session
file behind, and the prompt goes in through `-t`.

The Aider, OpenCode, Continue, Goose and Kimi Code assistants are **built from documentation and never exercised live** — those
CLIs are not installed on the development machine. **Cursor** has no model API of its own, so no
assistant.

## 6. Scripts

A section of **the panel itself**: your own files (`.mjs`, `.sh`, `.ps1`, `.py`) in the `hooks/`
folder of the panel directory. Neither the provider's CLI nor its config format is involved, so it
works everywhere. Exactly two things in it are Claude-specific and hidden for the rest: the
**sandbox** (it boots an isolated Claude Code) and the **"called by a hook"** flag. The code
scaffolds are swapped too: without hooks you get standalone scripts instead of hook skeletons.

## 7. Projects

The project registry is shared; the selected project's config differs per provider.

| CLI       | Available inside a project                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude    | `CLAUDE.md`, `.mcp.json`, permissions in `.claude/settings.json`                                                                                                 |
| Codex     | `AGENTS.md`, MCP in `.codex/config.toml`                                                                                                                         |
| Gemini    | `GEMINI.md`, MCP + permissions in `.gemini/settings.json`, env in `.gemini/.env`                                                                                 |
| Qwen Code | `QWEN.md`, MCP + permissions + **hooks** in `.qwen/settings.json`, env in `.qwen/.env`, **skills** in `.qwen/skills/`                                            |
| Continue  | the rules directory `<project>/.continue/rules/*.md`, MCP in `.continue/mcpServers/mcp.json`, env in `.continue/.env`                                            |
| Goose     | `<project>/.goosehints` only — Goose reads no project `config.yaml`                                                                                              |
| Kimi Code | `AGENTS.md`, MCP in `.kimi-code/mcp.json`, **skills** in `.kimi-code/skills/`; no project permissions or hooks — the CLI reads those from a single `config.toml` |
| Cursor    | rules directory `<project>/.cursor/rules/*.mdc`, MCP in `.cursor/mcp.json`, permissions in `.cursor/cli.json`                                                    |
| OpenCode  | `AGENTS.md`, MCP and permissions in `opencode.json`                                                                                                              |
| Aider     | `<project>/.aider.conf.yml`: the `read` list and `set-env`, as globally                                                                                          |

Aider's config, per its docs, is looked up in the home directory, **in the git repository root**
and in the current directory — in that order, later wins. Edits go through the same adapters as the
global level: other keys and comments stay intact, a backup precedes every write, and any path
leaving the project directory is rejected.

## 8. Hooks

**Claude** has its own model: `PreToolUse`/`PostToolUse` events with tool matchers and shell
commands in `settings.json`.

**OpenCode** uses the `experimental.hook` key of `opencode.json` (global and per-project), with
exactly two events: **"file edited"** (`file_edited`) maps a file pattern to a list of actions, and
**"session completed"** (`session_completed`) is simply a list of actions. A command is a **list of
arguments**, not a shell string: the program first, then its arguments one per field — a space
inside an argument is safe, while "`prettier --write`" as one string will not work, which is why
the panel shows separate fields. Only that key is edited: the rest of the file, other
`experimental` keys and unknown events are preserved read-only.

**The section is read-only.** The key lived under `experimental`, which OpenCode
itself declares unstable — and it did disappear: `experimental.hook` is no longer mentioned in the
configuration reference, it is absent from the published schema, and `experimental` there is closed
to unknown keys, so the schema rejects such a key outright. The panel stopped writing it: writing
into someone else's config something that appears neither in the documentation nor in the schema is
guesswork.

What remains: the panel still **shows** what is already in your file (your hooks are not lost and
can still be edited by hand), and refuses a write with exactly that reason. The documented way to
attach an action to an event is now plugins alone (section 9), which the panel supports. Should the
key be documented again, the section comes back with no rework.

**Qwen Code** keeps hooks under the root `hooks` key of `settings.json` — the very file where the
panel already edits permissions and the approval mode (global `~/.qwen/settings.json` and per
project `<project>/.qwen/settings.json`). The shape is event → list of groups, a group having an
optional `matcher` and a single action `{ "type": "command", "command": …, "timeout": … }`. The
**timeout is in milliseconds** (60,000 by default). There are eighteen events (`PreToolUse`,
`PostToolUse`, `SessionStart`, `SubagentStop`, `PreCompact`, `Notification` and others); six of them
— `UserPromptSubmit`, `MessageDisplay`, `Stop`, `StopFailure`, `TodoCreated`, `TodoCompleted` — take
no matcher per the docs, and the panel simply hides the field.

Preservation is **per event**: a group with two actions, an action whose type is not `command`, a
foreign field, an event outside the list — and **that whole event** turns read-only (the panel shows
it as raw JSON and never rewrites it), while the remaining events stay editable. The
`disableAllHooks` key is shown as a warning only: while it is on the CLI runs no hook at all, and it
is cleared by hand.

**Kimi Code** keeps hooks as an array of `[[hooks]]` tables in `~/.kimi-code/config.toml` (the same
file as permissions). There are exactly four fields: `event`, an optional `matcher` (a regular
expression), `command` (a shell string) and `timeout` — **in seconds**, 1–600, 30 by default. There
are sixteen events; the first three — `UserPromptSubmit`, `PreToolUse`, `Stop` — can block the
action with exit code 2. Kimi has no project hooks at all: this CLI reads no project `config.toml`.

The difference from Qwen is in the guard: a flat TOML array cannot be rewritten partially without
losing foreign data, so any deviation from the documented shape — an unknown field, an event outside
the list, a timeout out of bounds — turns **the whole section** read-only rather than a single
entry. The write is surgical: only the contiguous `[[hooks]]` region is replaced, comments and the
order of other keys survive, and an empty list deletes that region.

## 9. Plugins

For **Claude** these are the panel's own extensions and marketplaces (a wrapper around
`claude plugin`).

For **OpenCode** these are plugins of its own CLI, in two documented forms:

- **Files** in JS/TS inside the directory OpenCode loads at startup:
  `~/.config/opencode/plugins/`, per project `<project>/.opencode/plugins/`. The panel manages them
  as a file manager (list including subdirectories, read, create, edit, delete); a backup precedes
  every write and delete, and the directory is created only on an explicit save. Path safety is the
  same as for Cursor rules.
- **A list of npm packages** under the `plugin` key of `opencode.json`, scoped `@org/name`
  included. The panel cannot install packages — only edit the list. Entries of the "name + options
  object" form are allowed by the schema but undocumented in shape: kept as is, read-only.

For **Kimi Code** plugins are installed and enabled by the `/plugins` command inside the CLI itself,
so the section is **read-only** in the panel — a decision, not a gap. The panel reads
`~/.kimi-code/plugins/managed/<id>/` and each plugin's manifest (`kimi.plugin.json` or
`.kimi-plugin/plugin.json`) and lists them: name, version, description and what the plugin brings —
skills, a session-start skill, MCP servers, how many hooks it declares, whether it has commands.
Next to that is the path to the registry `~/.kimi-code/plugins/installed.json`. The shape of that
registry is undocumented, and editing state behind `/plugins`'s back would be guesswork: a write
attempt is refused with exactly that reason. A broken manifest does not break the list — such a
plugin is shown with an error mark.

## 10. Skills

For **Claude** this is the rich section: a folder per skill with a file tree, enable/disable by
moving into `skills-disabled/`, groups, a template library.

For **OpenCode** the concept is the same (a folder with `SKILL.md` and YAML front matter), but the
directories and fields are its own: `~/.config/opencode/skills/<name>/SKILL.md`, per project
`<project>/.opencode/skills/<name>/SKILL.md`. The panel edits the two required front-matter fields,
`name` and `description`; `license`, `compatibility`, `metadata` and any foreign fields are kept as
is, read-only. The name must equal the folder name and follow the rules (1–64 characters, lowercase
letters, digits, single hyphens, none at the edges, no `--`), checked before writing. A path must
have the form `<name>/SKILL.md` inside the directory; folders are created only on an explicit save.

Worth knowing: OpenCode also loads skills from `~/.claude/skills` and `~/.agents/skills`, so your
Claude skills work in it without moving anything — the panel says so and never writes into those
directories.

For **Qwen Code** and **Kimi Code** the format is the same — a folder with `SKILL.md` and a `name` +
`description` front matter — only the directories differ: `~/.qwen/skills/` and
`<project>/.qwen/skills/` for Qwen, `~/.kimi-code/skills/` for Kimi (per project
`<project>/.kimi-code/skills/`). Kimi, like OpenCode, also picks up the shared `~/.agents/skills`
directory — the panel says so and writes nothing there. One difference: Kimi's docs cap
`description` at 240 characters, and the panel checks exactly that bound. The skill name is held to
the strictest of the three rules (lowercase letters, digits, single hyphens) — such a name is valid
in any of these CLIs, so moving a skill between them needs no renaming.
