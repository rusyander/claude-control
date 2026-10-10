// PreToolUse (Bash|Agent|Task) on a local-model run (AGENTDECK_KIT_VARIANT=local): no background work.
//
// rules/local.md asks for it in words; a small model forgets words, and a background shell or
// subagent on a local model is the costly failure: the GPU serves one request at a time, so a
// background agent stalls the main loop, and its result arrives after the model has moved on and
// lost the thread (live Qwen Code runs 08.10). Parallel calls are serialized by the CLI itself where
// it allows it (Claude: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1, set by the panel on local runs).
// Outside the local variant this item is silent.

/** @returns {null | {decision:'deny', reason:string}} */
export default function localDiscipline(input) {
  if ((process.env.AGENTDECK_KIT_VARIANT ?? '').trim() !== 'local') return null;
  const tool = String(input?.tool_name ?? '');
  const arg = input?.tool_input ?? {};
  if (arg.run_in_background !== true && arg.run_in_background !== 'true') return null;
  const what = tool === 'Bash' || tool === 'PowerShell' ? 'command' : 'subagent';
  return {
    decision: 'deny',
    reason:
      `Local model: no background ${what}s — the GPU serves one request at a time. ` +
      'Repeat the same call without run_in_background and wait for its result.',
  };
}
