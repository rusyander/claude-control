// PreToolUse (Bash|PowerShell|Agent|Task) on a local-model run (AGENTDECK_KIT_VARIANT=local): no
// background COMMANDS.
//
// rules/local.md asks for it in words; a small model forgets words. A background shell is the costly
// failure: the model sleep-polls it, burning turns and window (live Qwen Code runs 08.10). A
// background SUBAGENT is allowed since 15.10 (L6, owner: local runs get what cloud Claude gets): the
// main turn ends, the GPU serves the subagent's requests in turn, and its completion notification
// wakes the main turn — the panel keeps the session alive for it. Parallel calls are serialized by
// the CLI itself where it allows it (Claude: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1, set by the panel
// on local runs). Outside the local variant this item is silent.

import { backgroundParam } from './kit-paths.mjs';

/** @returns {null | {decision:'deny', reason:string}} */
export default function localDiscipline(input) {
  if ((process.env.AGENTDECK_KIT_VARIANT ?? '').trim() !== 'local') return null;
  const tool = String(input?.tool_name ?? '');
  const arg = input?.tool_input ?? {};
  if (arg.run_in_background !== true && arg.run_in_background !== 'true') return null;
  if (tool === 'Agent' || tool === 'Task') return null;
  // Qwen reaches here normalised (`is_background` → run_in_background); the text names ITS flag.
  return {
    decision: 'deny',
    reason:
      'Local model: no background commands — polling one burns the context window. ' +
      `Repeat the same call without ${backgroundParam(input) ?? 'run_in_background'} and wait for its result.`,
  };
}
