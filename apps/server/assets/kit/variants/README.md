# Kit variants — per-CLI overlays

`agentdeck-kit/` is a Claude Code plugin (`.claude-plugin/plugin.json`, `skills/`, `commands/`,
`agents/`, `hooks/hooks.json`, `rules/`). Codex and Qwen Code both read that format as-is; a variant
is the small set of files copied OVER a copy of the kit for one CLI, never a fork of it. Generated
from the kit (commands and hook commands stay identical), so edit the kit first.

| CLI    | Overlay                                                             | What it changes                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| codex  | `codex/.codex-plugin/plugin.json`, `codex/hooks/hooks.codex.json`   | Native manifest (Codex probes `.codex-plugin` first); hook matchers in Codex tool names: `Bash`, `apply_patch`, `mcp__…`                                                                   |
| qwen   | `qwen/qwen-extension.json`, `qwen/commands/*.md`, `qwen/rules/*.md` | Native manifest; commands use `{{args}}` — Qwen leaves `$ARGUMENTS` in a Markdown command untouched; `rules/` (Qwen tool names) goes into `QWEN.md` after the kit rules, before `local.md` |
| claude | none                                                                | The kit itself                                                                                                                                                                             |

Hooks-only variants — the CLI cannot read the kit's skills/commands/agents, so only the economy and guard
hooks travel. Every hook command runs the SAME dispatcher (`hooks/lib/run.mjs`) with `--cli=<id>`; the
dialect (`hooks/lib/kit-paths.mjs`) maps the CLI's tool names and input onto Claude's and writes the
answer in the CLI's own form. None of these CLIs has an «ask» answer: an ask becomes a deny telling the
model to get the user's yes in chat first (`ASKLESS`, `hooks/lib/items.mjs`).

| CLI      | Overlay                                                   | Hook format                                                                                                                                  |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| gemini   | `gemini/gemini-extension.json`, `gemini/hooks/hooks.json` | Gemini CLI extension: `BeforeAgent`/`BeforeTool`/`AfterTool`/`AfterAgent`, `${extensionPath}`, timeouts in ms, deny = `{decision:"deny"}`    |
| goose    | `goose/plugin.json`, `goose/hooks/hooks.json`             | Goose plugin (Claude-shaped events), `${PLUGIN_ROOT}`, timeouts in s; deny = block                                                           |
| kimi     | `kimi/hooks.toml`                                         | `[[hooks]]` blocks for Kimi's `config.toml`; no root variable, the kit path is written out; timeouts in s                                    |
| opencode | `opencode/plugins/agentdeck-kit.js`                       | JS plugin shim: `tool.execute.before` throws to refuse, `tool.execute.after` feeds the post half, `chat.message` records the prompt; no Stop |

## Hooks-only install (by hand — none of these can take hooks for one launch)

- **Gemini CLI**: copy the kit to `~/.gemini/extensions/agentdeck-kit/`, then `gemini/*` over it.
  Not run live here (not installed); the format is checked against the published schema and a fake
  CLI that follows the docs (`variant-formats.test.ts`, `tools/qa/fake-hook-cli.mjs`).
- **Goose**: copy the kit to `<project>/.agents/plugins/agentdeck-kit/` (or `~/.agents/plugins/` for every
  project, per the Goose docs), then `goose/*` over it.
  Live-checked on goose 1.54.0 (`tools/qa/check-kit-variant-live.mjs goose`). On Windows Goose runs
  hook commands through `sh` — Git for Windows must be on PATH.
- **Kimi Code**: append `kimi/hooks.toml` to the `config.toml` Kimi reads and replace `<kit>` with the
  absolute path of a kit copy. Not installed here; checked like Gemini.
- **OpenCode**: copy `opencode/plugins/agentdeck-kit.js` into `~/.config/opencode/plugins/` (or a
  project's `.opencode/plugins/`) and set `AGENTDECK_KIT_DIR` to a kit copy. Never point
  `OPENCODE_CONFIG_DIR` at the kit: OpenCode reads its Claude-format `agents/*.md` and refuses to
  start. OpenCode takes the session directory from `PWD`. No Stop check — `session.idle` cannot hold
  a turn. Live-checked on opencode 1.18.35.

Not wired, by reason: **continue** (`cn` 1.5.47 has a hook format but never fires it — proven with a
control in `check-kit-variant-live.mjs continue`), **cursor** (the panel does not launch it),
**aider** (no tool loop to intercept). The panel shows the same split on the Kit modes card
(`HOOKS` in `apps/server/src/domains/kit/service.ts`).

## One-launch delivery (checked on codex-cli 0.160.1, qwen-code 0.25.0)

- **Claude**: `claude --plugin-dir <kit>` (what the panel does today).
- **Codex**: `CODEX_HOME=<isolated dir>` + a local marketplace dir holding
  `.claude-plugin/marketplace.json` → `codex plugin marketplace add <dir>` →
  `codex plugin add agentdeck-kit@<marketplace>`. All 44 skills load as `agentdeck-kit:<name>`.
  Hooks run only after the user trusts them in `/hooks` (Codex hashes each definition; a changed
  hook needs a new review). Codex sets `CLAUDE_PLUGIN_ROOT` for plugin hooks; `ask` is not a Codex
  decision, so the kit turns it into `deny` with the reason (`hooks/lib/items.mjs`).
- **Qwen**: `QWEN_HOME=<isolated dir>` + `qwen extensions install <kit copy> --consent` (or `link`).
  Skills, commands, agents and `hooks/hooks.json` load; `${CLAUDE_PLUGIN_ROOT}` is substituted with
  the extension path and Claude tool names in matchers are mapped to Qwen's (`Bash` →
  `run_shell_command`, …). Qwen also treats `rules/*.md` as conditional rules and skips each one
  without `paths:` with a warning per launch — the rules still reach the model through the
  SessionStart hook.

Neither route touches the user's own `~/.codex` / `~/.qwen` when the home variable points at an
isolated dir.

## Local-model variant (`AGENTDECK_KIT_VARIANT=local`)

Not an overlay of files: the same kit, switched by the env the panel sets on a local-model contour run.
`rules/local.md` joins the rules (last), the `local-discipline` hook refuses background commands and
subagents, `spawn-cost-guard` stops asking about a single subagent, and Claude Code also gets
`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1` (tool calls one at a time; the CLI default is 10).
