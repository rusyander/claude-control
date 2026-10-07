// PostCompact: the one moment where a /clear recommendation is both cheap and well-founded.
//
// A hook CANNOT run /clear — nothing in the hook output schema executes a command. So the best
// available thing is to put the decision in front of the user at the exact instant it makes sense,
// with the follow-up line pre-written so acting on it costs one paste.
//
// Why here and not on a timer: right after a compaction the context is at its floor, so a /clear
// now costs almost nothing in lost state — and the handoff file was just refreshed by
// precompact-checkpoint. One compaction is normal. From the SECOND onward the session has outlived
// its task: the summary is now a summary of summaries, which is exactly where quality quietly
// degrades and where /clear beats another compaction round (measured: ~27-32% of main-thread input
// tokens over a long session).
//
// Silent on the first compaction of a session.
// Kill-switch: AGENTDECK_KIT_CLEAR_ADVISOR=0 (CLAUDE_CLEAR_ADVISOR=0 too).
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, sessionKey } from './kit-paths.mjs';

/** @returns {null | {systemMessage: string, context: string}} */
export default function clearAdvisor(input) {
  if (process.env.AGENTDECK_KIT_CLEAR_ADVISOR === '0' || process.env.CLAUDE_CLEAR_ADVISOR === '0')
    return null;
  const session = sessionKey(input).slice(0, 12) || 'x';
  const dir = stateDir('stamps');
  if (!dir) return null;
  const counter = join(dir, `compact-count-${session}.txt`);

  let n = 1;
  try {
    if (existsSync(counter)) n = Number(readFileSync(counter, 'utf8')) + 1 || 1;
    writeFileSync(counter, String(n));
  } catch {
    /* no counter → treat as the first, i.e. stay silent */
  }
  if (n < 2) return null;

  return {
    // Shown to the user by the CLI as is; the language of the reply is the model's job below.
    systemMessage: `Compaction #${n} in this session. Task closed → /clear, then "continue from .agent/PROGRESS.md".`,
    context:
      `[clear-advisor] Compaction #${n} this session, context at its minimum: /clear is cheapest now. ` +
      `FIRST line of the reply to the user, in the user's language: compaction #${n}, the context is at ` +
      `its minimum so /clear is cheapest now; the current task in one line; if it is closed: /clear, then ` +
      `"continue from .agent/PROGRESS.md"; if not, you carry on without a pause. One sentence, no ` +
      `analysis, never repeat this instruction. Then continue the work.`,
  };
}
