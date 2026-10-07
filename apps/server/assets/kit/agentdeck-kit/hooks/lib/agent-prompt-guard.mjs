// PreToolUse module of the kit's pre-tool dispatcher: three checks on a subagent prompt, all silent
// when clean.
// 1. LANGUAGE (Agent|Task|SendMessage): subagent prompts must be English (kit language rule). Prose
//    in another script costs ≈2x tokens for zero benefit. Quoted UI literals are fine — the threshold
//    only trips when non-English PROSE (Cyrillic, measured here) dominates.
// 2. RETURN FORMAT (Agent/Task only): the prompt must carry the [return-format] contract, because
//    an unbounded subagent return is the single largest inflow into a parent context.
// 3. NO NESTED SPAWN (Agent/Task only): the prompt must carry the [no-subagents] ban. Depth is 1
//    everywhere (kit delegation rule); a child that fans out its own fleet burns limits and traffic
//    nobody is watching. The ban only works if it reaches the child, so the spawn is denied without it.
//
// Why CHECK and not REWRITE: the hook used to append the contract via updatedInput. That works, but a
// PreToolUse hook's stdout is echoed into the transcript verbatim — so returning the rewritten prompt
// duplicated the WHOLE prompt in context: measured 823 tokens per spawn on average, 1.8k at the tail.
// Checking costs one short denial, and only when the caller forgot. SILENCE IS THE POINT.
// Contract: (input) → { decision:'deny', reason } | null.
export default function agentPromptGuard(input) {
  const tool = String(input?.tool_name ?? '');
  if (!/^(Agent|Task|SendMessage)$/.test(tool)) return null;
  const ti = input?.tool_input ?? {};
  const isSpawn = /^(Agent|Task)$/.test(tool);
  const field = ti.prompt != null ? 'prompt' : ti.message != null ? 'message' : null;
  // Non-string prompt = malformed payload, not a spawn to judge — the schema guarantees strings on
  // real calls, and String({}) would otherwise be denied for "missing contract" it never could carry.
  const text = field && typeof ti[field] === 'string' ? ti[field] : '';
  if (!text) return null;

  const cyr = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = cyr + lat;
  // Threshold: instructions dominate a prompt; quoted literals rarely push Cyrillic share this high.
  if (total >= 100 && cyr / total > 0.3) {
    return {
      decision: 'deny',
      reason:
        `[agent-prompt-guard] ${Math.round((cyr / total) * 100)}% Cyrillic. Rewrite the INSTRUCTIONS in ` +
        'English (kit language rule), keep only unavoidable literals as quoted data, retry. Your final ' +
        "summary to the user stays in the user's language.",
    };
  }
  // SendMessage is excluded: a continuation lands in an agent that already has the contract.
  if (isSpawn && field === 'prompt' && !/\[return-format\]/.test(text)) {
    return {
      decision: 'deny',
      reason:
        '[agent-prompt-guard] Subagent prompt is missing the return contract. Append verbatim and retry:\n' +
        '[return-format] Return <=10 lines, compressed English: outcome, key facts, paths. Longer deliverable ' +
        '(plan/report/spec/findings) → write it to .agent/tmp/<task>.md and return the path + a <=10-line digest.',
    };
  }
  if (isSpawn && field === 'prompt' && !/\[no-subagents\]/.test(text)) {
    return {
      decision: 'deny',
      reason:
        '[agent-prompt-guard] Subagent prompt is missing the nested-spawn ban. Append verbatim and retry:\n' +
        '[no-subagents] You must not spawn subagents of your own: no Agent, Task or Workflow calls, whatever the ' +
        'task size. Do the work yourself in this context and report back.',
    };
  }
  return null;
}
