# What the panel does not do for other CLIs

A continuation of [What the panel does not do](LIMITATIONS.md) — the multi-provider part.
Marks: **by design** — meant to be this way; **not ours** — a limitation of that CLI; **honest** —
it works, but is not fully verified; **not yet** — worth doing, the adapter is not written.

🇷🇺 [Русская версия](LIMITATIONS-PROVIDERS.ru.md) · 🚫 [Main list](LIMITATIONS.md) ·
🔌 [Providers: format details](PROVIDERS.md)

---

## CLIs other than Claude

The panel configures more than Claude Code, but the honest phrasing is: **far from everything is
universal.** The map below says what exists where; format details are in
[PROVIDERS.md](PROVIDERS.md); here are the boundaries.

### The map: section × provider

**✅ works** · **👁 read-only** — the section is there, but the panel never writes into it (why — in the footnote) · **🧪 experimental** · **— unsupported**, section hidden.

|                                     | Claude | Codex | Gemini | Qwen | Continue | Goose | Kimi | Cursor | OpenCode | Aider |
| ----------------------------------- | :----: | :---: | :----: | :--: | :------: | :---: | :--: | :----: | :------: | :---: |
| Global instructions<sup>1</sup>     |   ✅   |  ✅   |   ✅   |  ✅  |    —     |  ✅   |  ✅  |  ✅ *  |    ✅    | ✅ *  |
| MCP servers<sup>2</sup>             |   ✅   |  ✅   |   ✅   |  ✅  |    ✅    |  ✅   |  ✅  |   ✅   |    ✅    |   —   |
| Environment<sup>3</sup>             |   ✅   |  ✅   |   ✅   |  ✅  |    ✅    |   —   |  —   |   —    |    —     |  ✅   |
| Permissions / approvals<sup>4</sup> |   ✅   |  ✅   |   ✅   |  ✅  |    ✅    |  ✅   |  ✅  |   ✅   |    ✅    |   —   |
| Chat<sup>5</sup>                    |   ✅   |  🧪   |   🧪   |  🧪  |    🧪    |  🧪   |  🧪  |   —    |    🧪    |  🧪   |
| Rules (`## ПРАВИЛО:`)               |   ✅   |   —   |   —    |  —   |    —     |   —   |  —   |   —    |    —     |   —   |
| Skills<sup>10</sup>                 |   ✅   |   —   |   —    |  ✅  |    —     |   —   |  ✅  |   —    |    ✅    |   —   |
| Commands<sup>11</sup>               |   👁    |   —   |   👁    |  👁   |    —     |   —   |  —   |   —    |    👁     |   —   |
| Hooks<sup>8</sup>                   |   ✅   |   —   |   —    |  ✅  |    —     |   —   |  ✅  |   —    |    👁     |   —   |
| Scripts<sup>6</sup>                 |   ✅   |  ✅   |   ✅   |  ✅  |    ✅    |  ✅   |  ✅  |   ✅   |    ✅    |  ✅   |
| Plugins<sup>9</sup>                 |   ✅   |   —   |   —    |  —   |    —     |   —   |  👁   |   —    |    ✅    |   —   |
| Projects<sup>7</sup>                |   ✅   |  ✅   |   ✅   |  ✅  |    ✅    |  ✅   |  ✅  |   ✅   |    ✅    |  ✅   |
| Analytics (tokens, cost)            |   ✅   |   —   |   —    |  —   |    —     |   —   |  —   |   —    |    —     |   —   |
| Sandbox                             |   ✅   |   —   |   —    |  —   |    —     |   —   |  —   |   —    |    —     |   —   |

**Overview, Search, Groups, History, Settings and Help are always there** — those are the panel's own sections. History and search do follow the active provider's files: foreign backups are named separately and never mix with Claude's.

What each footnote stands for — the file path, the keys the panel edits, the reason behind the status — is in [Providers: format details](PROVIDERS.md).

### Claude-only by nature

| What                                                               | Why                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Token analytics, the sandbox, plugin marketplaces                  | **not ours.** The other CLIs either have no such entity or build it on fundamentally different lines                                |
| Rules (`## ПРАВИЛО:` inside `CLAUDE.md`)                           | **by design.** Splitting the file into named sections is this panel's convention; elsewhere the instructions file is edited whole   |
| The agent's work in the chat: tools, steps, cost, branching, voice | **by design.** All of it is parsed out of the `claude` CLI's streaming protocol; no other CLI publishes a documented format like it |
| History and search across every section at once                    | **by design.** For a foreign provider only its working sections reach the feed and the search                                       |

Hooks, plugins and skills are the exception: OpenCode, Qwen Code and Kimi Code have them, each in
its own model, as separate sections.

### The chat for foreign providers

Conversations, memory between questions, the reply as it is printed, a working directory and file
attachments work for every CLI with a documented non-interactive entry point. The boundaries follow.

| What                                                                     | Why                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The panel keeps the transcript, not the CLI                              | **by design.** These CLIs either have no readable history of their own or its format is undocumented. Conversations live in the panel's files, and the context of the next question is assembled from them               |
| The raw CLI output is shown, with no parsing of steps or tools           | **not ours.** None of these CLIs publishes a streaming format with steps; showing anything beyond the printed bytes would mean inventing a format on their behalf                                                        |
| A long conversation is trimmed from the front (around 24 000 characters) | **not ours.** The prompt travels as a separate command-line element, and the command line is cut at about 32 000 characters; dropping old turns beats silently sending half a question                                   |
| An attachment is a file path, not the file's content                     | **by design.** Agent CLIs read files themselves; embedding the content into the prompt would mean inventing their attachment format                                                                                      |
| OpenCode holds a session instead of a run per question                   | **by design.** The panel runs `opencode serve`, so the context is not resent; the answer then arrives whole rather than as it is printed, and a hiccup of that server drops the conversation back to the one-shot stream |
| The Aider, OpenCode, Continue, Goose and Kimi Code chats never ran live  | **honestly.** Those CLIs are not installed on the dev machine: the launch comes from documentation and is covered by argv-shape tests                                                                                    |
| Cursor has no chat and will not get one                                  | **not ours.** Cursor has neither a non-interactive entry point nor a model API of its own                                                                                                                                |

### Sections still open per provider

What exactly is edited for each CLI is in [PROVIDERS.md](PROVIDERS.md); below are the boundaries
only.

| What                                                                                 | Why                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cursor:** a rule with unparseable frontmatter is read-only                         | **by design.** Rewriting markup the panel did not understand would be blind; a plain `.md` is ignored by Cursor anyway                                                                                                                                                                                                 |
| **Aider:** no MCP servers at all                                                     | **not ours.** Aider's options reference has no MCP setting — nothing to configure                                                                                                                                                                                                                                      |
| **Gemini:** the `yolo` mode is unavailable                                           | **not ours.** Per the docs it is a command-line flag; in `settings.json` it makes the CLI fail. Need it — run `gemini --yolo`                                                                                                                                                                                          |
| **OpenCode:** no environment variables at all                                        | **not ours.** There is nowhere to store them: OpenCode reads the already-set process environment and loads no `.env` of its own                                                                                                                                                                                        |
| **OpenCode:** unrecognised `permission` entries are read-only                        | **by design.** An entry in a form the panel does not manage stays as is; `agent.*` overrides are not touched at all                                                                                                                                                                                                    |
| **OpenCode:** hooks are read-only                                                    | **not ours.** `experimental.hook` is gone from both the configuration reference and the published schema, and `experimental` there is closed to unknown keys. The panel shows what is already in the file but has stopped writing; the documented way to attach an action to an event in OpenCode is now plugins alone |
| **OpenCode:** exactly two hook events                                                | **not ours.** Only `file_edited` and `session_completed` are documented; the panel will not invent events                                                                                                                                                                                                              |
| **OpenCode:** a hook command is an argv list                                         | **not ours.** The action runs without a shell: pipes, `&&`, substitutions and redirects do not work — call a shell explicitly if needed                                                                                                                                                                                |
| **OpenCode:** npm plugins are not installed by the panel                             | **by design.** The `plugin` key is a list of names; fetching is the CLI's job                                                                                                                                                                                                                                          |
| **OpenCode:** Claude skills are shown but never touched                              | **honestly.** OpenCode also loads them from `~/.claude/skills` and `~/.agents/skills`; Claude's own section manages those                                                                                                                                                                                              |
| **Everywhere:** the Commands section only reads                                      | **by design.** The list merges four sources into one display case; editing happens in Skills or Plugins, and the panel writes command files for no CLI                                                                                                                                                                 |
| **Codex, Continue, Goose, Kimi Code, Cursor, Aider:** no Commands section            | **not ours.** The format of user slash commands is not covered by their documentation, and the panel will not invent one                                                                                                                                                                                               |
| **Everyone but Claude:** a narrower project level                                    | **not yet + not ours.** Only what each CLI documents is editable                                                                                                                                                                                                                                                       |
| An "in development" section reads and writes nothing                                 | **by design.** Fail-closed: a stub instead of a guess about the format                                                                                                                                                                                                                                                 |
| **Qwen Code:** a hook event of an unfamiliar shape turns read-only                   | **by design.** Fail-closed: a group with two actions, an action whose type is not `command` or a foreign field — and the panel keeps that whole event as is, while the rest stay editable                                                                                                                              |
| **Qwen Code:** one action per hook group                                             | **by design.** The panel manages the "event → matcher → command" shape; a list of several actions is preserved but not editable                                                                                                                                                                                        |
| **Continue:** no global instructions at all                                          | **not ours + by design.** Only the project rules directory is documented; the config's `rules:` key is heterogeneous (inline strings mixed with `uses:` references) and the panel will not guess                                                                                                                       |
| **Continue:** a new server always lands in `config.yaml`                             | **by design.** Block files `mcpServers/*.yaml` are read and edited where the entry lives, but the panel creates none of its own: naming that file is the person's call                                                                                                                                                 |
| **Continue:** a block with a `uses:` reference or any foreign shape is skipped whole | **by design.** Fail-closed per file: such a file is neither shown nor touched, and the panel names it with the reason; the other blocks keep working                                                                                                                                                                   |
| **Continue:** the global block folder `~/.continue/mcpServers` is unverified live    | **honestly.** The docs describe the block folder inside a workspace; the CLI scans the global one with the same code, but the panel has never checked that against a live Continue                                                                                                                                     |
| **Continue:** comments inside the `mcpServers` block do not survive a write          | **honestly.** The block is rebuilt from values — otherwise unmodelled entry fields could not be preserved; comments outside the block stay                                                                                                                                                                             |
| **Goose:** no environment section                                                    | **not ours + by design.** Goose has no `.env` of its own — keys live in the OS keyring or in `secrets.yaml`, and the panel does not keep secrets                                                                                                                                                                       |
| **Goose:** `permission.yaml` is shown but never written                              | **not ours.** Its format is absent from the Goose documentation: only the three levels and the `goose configure` flow are documented. The panel will not write a foreign format read off the sources — it shows what is configured and points at `goose configure`                                                     |
| **Goose:** built-in extensions are shown nowhere and never written                   | **by design.** `developer`, `memory` and the rest are parts of the CLI itself, not MCP servers: a write landing on such an entry is refused                                                                                                                                                                            |
| **Goose:** comments inside an edited extension entry do not survive a write          | **honestly.** The entry is rebuilt from values so that unmodelled fields (`timeout`, `cwd`, `env_keys`) can be carried over; everything outside it stays                                                                                                                                                               |
| **Kimi Code:** no environment section                                                | **not ours + by design.** It reads no `.env` of its own: provider keys sit in `config.toml`, and the panel writes no secrets into a foreign config                                                                                                                                                                     |
| **Kimi Code:** any deviation in `[[hooks]]` turns the section read-only              | **by design.** Fail-closed: a flat array of TOML tables cannot be rewritten partially without losing foreign entries, so the whole section is locked rather than a single row                                                                                                                                          |
| **Kimi Code:** no project hooks                                                      | **not ours.** This CLI reads no project `config.toml` — hooks exist at the user level only                                                                                                                                                                                                                             |
| **Kimi Code:** plugins are read-only                                                 | **not ours + by design.** Installing, enabling and disabling happen in the CLI via `/plugins`; the shape of the `plugins/installed.json` registry is undocumented, and editing that state behind its back would be guesswork                                                                                           |
| **Kimi Code:** no project-level permissions                                          | **not ours.** The CLI reads exactly one user-level `config.toml`; per-project isolation is done by swapping `KIMI_CODE_HOME`                                                                                                                                                                                           |
| **Kimi Code:** a foreign field in `[permission]` turns the section read-only         | **by design.** Fail-closed: regenerating a block with an ununderstood field would drop someone else's data                                                                                                                                                                                                             |

### Care with foreign formats

| What                                                              | Why                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every provider but Claude is marked `experimental`                | **by design.** Formats come from documentation and round-trip tests, but only Claude's path was exercised live: eyeball the first real write                                       |
| A broken or unexpected foreign config makes the section read-only | **by design.** Fail-closed: an error instead of guessing, with the reason visible in the UI                                                                                        |
| Rolling back a foreign provider's backup is refused               | **by design.** The backups are visible in history and diff, but restoring a foreign config must be a deliberate manual act                                                         |
| Directory overrides are honoured only where documented            | **not ours.** Only `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, `QWEN_HOME`, `KIMI_CODE_HOME`. Gemini, Continue, Goose, Cursor and Aider document none |
| Multi-provider support was exercised live on Windows only         | **not yet.** The code is cross-platform and covered by platform-swapping tests, but no live run on macOS or Linux happened                                                         |
