// Module of prompt-dispatch.mjs. Contract: (input, prompt) → string | null.
// The prompt half of gate-at-end.mjs: once-at-end stages move to the end of the
// WHOLE task, and a follow-up prompt — mid-turn ones included, they fire this event too — moves them
// again. Silent until the session has run a full gate; then one line saying what the follow-up owes:
//   · a full gate still running in the background → stop it now (TaskStop), it checks a tree that is
//     about to change, and run it once when the grown task is done;
//   · a full gate already ran → the follow-up gets narrow checks; the full gate waits for delivery.
//     Said once per finished gate (firstHintFor), not on every later prompt.
import { sessionGates, hhmm, firstHintFor } from '../gate-at-end.mjs';

export default function gateDeferHint(input, prompt) {
  if (!prompt) return null;
  const gates = sessionGates(input);
  const last = gates[gates.length - 1];
  if (!last) return null;
  if (last.outcome === 'running') {
    return (
      `[gate-at-end] A full gate started at ${hhmm(last.ts)} is still running in the background` +
      (last.taskId ? ` (task ${last.taskId})` : '') +
      '. If this message adds or changes work, stop it NOW with TaskStop — it checks a tree that is about to ' +
      'change — do the new work with narrow checks, and run the full gate once at the end. If it only asks a ' +
      'question, let it finish.'
    );
  }
  // Keyed by the call id: the same gate read from state (after compaction) carries another ts.
  if (!firstHintFor(input, last.id ?? last.ts)) return null;
  return (
    `[gate-at-end] The full gate already ran this session (${hhmm(last.ts)}, ${last.outcome}). Work from this ` +
    'message is a follow-up: check it narrowly (tests of the touched files, lint/type-check of those files or ' +
    'their package). The full gate, mustfail and shots run once more at the end of the whole task — at ' +
    'delivery (commit, push, MR) or when the user closes it.'
  );
}
