---
name: token-economy
description: 'Use when a task is multi-step, spawns subagents, or context bloats — subagents report to file and return ≤10 lines, tiered verification, context budget.'
---

# Token-frugal orchestration

The dominant inflow into an orchestrator's context is NOT the edits — it is (a) subagent final reports, (b) raw command output, (c) repeated full verification runs, (d) re-reading files. Attack those four. Goal: a small task must not consume most of the window.

This is the multi-agent/long-session operational layer. The always-loaded CLAUDE.md already covers memory-index hygiene (Token & memory economy) and minimal-ceremony/round-trip discipline (Fast lane) — don't restate them; this skill adds the orchestration mechanics below.

## Levers, ordered by impact

### 1. Subagent I/O contract — the #1 lever

Every subagent writes its FULL report to `.agent/tmp/<task>.md` and returns to the orchestrator ONLY a fixed ≤10-line schema — nothing else, no narration, no code dumps, no rationale. Full detail lives in the file; the orchestrator reads it only if it actually needs a detail. Subagent reports are otherwise 3–5 KB each — this contract removes ~80% of the inflow.

State the literals `[return-format]` and `[no-subagents]` in every Agent/Task spawn prompt yourself; `agent-prompt-guard` (pre-tool-dispatch) DENIES a spawn whose prompt lacks either — it never appends anything. Exempt: `SendMessage` continuations (the agent already has it) and the Workflow tool — where the stronger form is a `schema` (JSON Schema), so the return is a validated object, not prose.

### 2. Tiered verification

On each step: cheap, targeted check of the TOUCHED package only (`--filter <pkg> type-check`, the single relevant test, and for server changes the cold-start check). Full gate (type-check + lint + depcruise + all tests) ONLY at a phase boundary. Every full run is a wall of text poured into context.

### 3. Summarize command output

Never let raw logs into context. Pipe through `| tail -n N`, `grep -c`, or reduce to one summary line. For test runs keep pass/fail counts, not the full reporter output. This is the default, not an exception.

### 4. Inline-vs-subagent triage

Small/quick edit → do it yourself inline. A subagent spin + its report is ~30–50 K of overhead — never worth it for a one-file change. Spawn a subagent ONLY when the work is genuinely large or isolable (noisy exploration whose many file-reads must NOT settle into the orchestrator's context) — and only once the user allowed spawning for THIS task (global CLAUDE.md: orchestration is opt-in).

### 5. Context budget + fresh subagents

Checkpoint to `.agent/PROGRESS.md` continuously. Auto-compact fires at 300k (`autoCompactWindow` in settings.json — check it, don't quote this line), so a session cannot grow unbounded, but a compact still costs detail. Past ~150k do NOT push more work through the bloated context: checkpoint PROGRESS.md and name `/clear` to the user (global CLAUDE.md) — the next session restarts from the checkpoint near 0. A FRESH subagent is the alternative only where spawning is allowed for this task. The bloated orchestrator re-sends its whole context on every remaining step.

### 6. Read / own registry

Don't re-read a file already read, or one a subagent currently owns. Read with offset/limit around a grep hit, not whole files. Don't restate facts already established in the conversation. Bundled scripts and CLI tools are black boxes: run `--help` and invoke — reading their source into context pays for what the interface already tells you.

### 7. Model & effort tiering (subagents)

Default: a subagent inherits the session model and effort — keep that for judgment, verification, and ambiguous work. For CLEARLY mechanical, isolable work (rename sweep, applying a known transform, run-and-summarize, bulk file discovery) delegate to a cheaper/faster model and lower reasoning effort: the saving is sharp and grunt work loses nothing by it. The currency is the **subscription's rate window**, not a bill — nothing here is charged in money, and the window is what actually stalls a long session or a batch sweep. NEVER downgrade model/effort for correctness-critical verification or design decisions. Rule of thumb: cheap model does the grunt work, the expensive orchestrator/verifier judges the result — and adversarial verification of a cheap agent's output is itself the quality guard. Ready-made types for an approved spawn (`<kit>/agents/`): `mechanical-worker` (effort low) for spec-complete edits, `readonly-researcher` (effort medium) for recon.

## What hooks do and do not cover

Automatic:

- levers 2 and 6 + TodoWrite spam — `pre-tool-dispatch` (context group): `verify-throttle` (re-run of an already-GREEN check with no new edits refused; a RED one and the batched `type-check && lint && test` always allowed), `read-discipline` (re-read of a file unchanged since this session read it denied), `doc-size-guard` (whole-file reads over the doc read cap; numbers: skill `agentdeck-kit:doc-hygiene` §3), `todo-throttle`, `search-discipline` (a long pure read sweep — only in a turn whose prompt allowed subagents). Every denial's escape hatch: repeating the identical call goes through;
- lever 1's contract — `agent-prompt-guard` denies a spawn missing `[return-format]` or `[no-subagents]` (writing them is on you) and blocks Russian prose in the prompt;
- skill discovery — `skill-hint` (a `prompt-dispatch` module) names ≤2 matching skills per prompt at zero standing cost (mechanics: skill `agentdeck-kit:skill-map`);
- the closing gate — `verify-at-stop` blocks a turn once when it edited code and ran no check after the last edit; `reply-language` when the final answer is not Russian.

Every guard yields to an explicit request ("re-read it", "run the tests") — `record-prompt` stores the turn's user message so that override survives a long turn, where the transcript tail alone would lose it.

Still on you, because no hook can judge it: what you put IN the prompt (lever 1 contract, lever 4 triage, lever 7 model tiering), and summarizing command output (lever 3).
