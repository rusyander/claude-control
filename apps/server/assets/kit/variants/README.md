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
