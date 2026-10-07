# Hook authoring — a hook script or its wiring is about to change

A hook fails SILENTLY: a missing script costs a node stack trace on every matching call, and a check
nothing references is simply dead. So the last step is always proving it fired.

## Where the code goes

One node process per event already exists — a new check is a MODULE, not a new settings entry. In this
kit: the logic in `hooks/lib/<name>.mjs`, a thin item file `hooks/<name>.mjs` exporting
`hooks = { <event>: spec }`, and its name in `MANIFEST` in `hooks/lib/items.mjs` (order matters).
PreToolUse returns `null | {decision:'deny'|'ask', reason}`, PostToolUse `null | string`, Stop
`null | {decision:'block', reason}`, UserPromptSubmit `(input, prompt) → string | null` (prompt is ''
on a synthetic turn — task notifications land there too). A thrown error skips the module, never fatal.
A project's own hooks follow its own layout; the contract is the same.

## Input and output

Input is JSON on stdin — `tool_name`, `tool_input`, `session_id`, `cwd`, `transcript_path`. Other CLIs
send other tool ids (Qwen: `run_shell_command`, `write_file`…; Codex: `apply_patch`) — the kit's
`normalize` maps them to one shape, so a module never branches on the CLI.
A plugin declares hooks in its own `hooks/hooks.json`; same contract.
Blocking: exit 2 with the reason on stderr, or `hookSpecificOutput.permissionDecision: "deny"`.
PreToolUse and UserPromptSubmit can also inject `additionalContext` with no verdict at all.
**stdout IS context**, re-billed on every later turn and capped (`CAP.pre` 1200 / `CAP.post` 700 in
`hooks/lib/dispatch.mjs`). State the verdict, point at the doc holding the procedure.
A hook resolves every path from its own file and writes only to the project's `.agent/` or a temp dir.

## Safety

Quote every expansion, never `eval` hook input, `--` before path arguments. `timeout` on anything
touching network or docker — a hung hook hangs the session. Hooks re-fire: keep them idempotent, and
put one that modifies files on PostToolUse, since PreToolUse races the edit it precedes.

## Gate — unproven is not delivered

A test case covering the new behaviour, green; the dispatcher run once with a real-shaped stdin
(`echo '<json>' | node hooks/lib/run.mjs pre`) and its output read; the real event fired once in a
session and its effect seen.
