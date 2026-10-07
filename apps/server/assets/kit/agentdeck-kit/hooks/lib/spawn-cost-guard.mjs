// PreToolUse (Agent|Task|Workflow): a fan-out is the most expensive thing an agent harness can do, and
// it is invisible while it happens — subagent traffic lands in separate transcripts, so the main
// chat shows one tool call where dozens of request loops ran.
//
// Measured on a real week of usage: 96% of the spend came from subagent-heavy sessions, 68% of it
// from a single workflow fan-out; one hour of it (181 agents, one per docs page, all inheriting the
// top model) cost ~5x an ordinary working hour. A subagent that inherits the top model for
// mechanical work (translation, extraction, mechanical edits) costs roughly 15x a mid-tier one.
//
// So the rule: nothing fans out until the user has seen HOW MANY agents and ON WHICH MODEL.
// `ask`, never `deny` — the user may well want the expensive version, they just get to say so.
// Silence (= allow) when every spawn already names a non-top model explicitly, for the two review
// agents of a live ticket run, and for tagged review lanes (review-spawn.mjs).
// Kill-switch: AGENTDECK_KIT_SPAWN_GUARD=0 (CLAUDE_SPAWN_GUARD=0 is honoured too).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveTicketRuns } from './ticket-run.mjs';
import { reviewSpawnAllows } from './review-spawn.mjs';
import { stateDir, sessionKey } from './kit-paths.mjs';

/** The cap IS the grant: the ticket pipeline names exactly two review agents; a third asks again. */
const TICKET_SPAWN_CAP = 2;

function takeTicketSpawn(input) {
  try {
    const dir = stateDir('stamps');
    if (!dir) return false;
    const stamp = join(dir, `ticket-spawn-${sessionKey(input).slice(0, 12) || 'x'}.stamp`);
    const n = (Number(existsSync(stamp) ? readFileSync(stamp, 'utf8') : 0) || 0) + 1;
    writeFileSync(stamp, String(n));
    return n <= TICKET_SPAWN_CAP;
  } catch {
    return false;
  }
}

/** The top, most expensive model tier — what an unnamed model inherits in a top-model session. */
const TOP = /opus/i;

/** @returns {null | {decision:'ask', reason:string}} */
export default function spawnCostGuard(input) {
  if (process.env.AGENTDECK_KIT_SPAWN_GUARD === '0' || process.env.CLAUDE_SPAWN_GUARD === '0')
    return null;
  const tool = String(input?.tool_name ?? '');
  const arg = input?.tool_input ?? {};

  if (tool === 'Agent' || tool === 'Task') return oneAgent(arg, input);
  if (tool === 'Workflow') return workflow(arg);
  return null;
}

function oneAgent(arg, input) {
  const model = String(arg.model ?? '');
  if (model && !TOP.test(model)) return null; // explicit cheaper model — nothing to warn about
  // Ticket pipeline review pass: both agents are named in the skill and granted with the ticket.
  // Asking about them turns an autonomous run into a dialogue.
  if (liveTicketRuns(input).length && takeTicketSpawn(input)) return null;
  // Tagged review lanes spawn unasked, up to a per-session cap.
  if (reviewSpawnAllows(input, arg)) return null;
  const what = String(arg.description ?? arg.subagent_type ?? 'subagent').slice(0, 60);
  const on = model ? `on ${model}` : 'with no model named — it inherits the session model';
  return {
    decision: 'ask',
    reason:
      `Spawning subagent "${what}" ${on}. A subagent runs its own request loop, invisible in the main ` +
      'chat. For mechanical work (translation, fact extraction, repetitive edits) a smaller model ' +
      'costs roughly 15x less. Allow as is?',
  };
}

function workflow(arg) {
  const src = String(arg.script ?? '');
  // scriptPath / saved name: the body is not in the tool input, so the count cannot be read.
  // Ask anyway — an unreadable fan-out is exactly the case that needs a human look.
  if (!src) {
    const ref = String(arg.scriptPath ?? arg.name ?? 'a script on disk');
    return {
      decision: 'ask',
      reason:
        `Workflow from "${ref}" — the script body is not in the call, so the agent count and models ` +
        'cannot be seen. Every agent() without a model inherits the session model. Run it?',
    };
  }

  const sites = [...src.matchAll(/\bagent\s*\(/g)];
  if (!sites.length) return null;

  // A site counts as priced only when a model is named inside its own opts object. Cheap textual
  // check on the tail of the call — a script that names the model somewhere far away is not
  // trusted, and being wrong here only costs one extra confirmation.
  let unpriced = 0;
  let topPriced = 0;
  for (const [n, site] of sites.entries()) {
    // Stop at the next spawn site, or a model named on a LATER call is credited to this one.
    const stop = Math.min(sites[n + 1]?.index ?? src.length, site.index + 400);
    const tail = src.slice(site.index, stop);
    const model = tail.match(/model\s*:\s*['"`]([^'"`]+)/);
    if (!model) unpriced++;
    else if (TOP.test(model[1])) topPriced++;
  }
  if (!unpriced && !topPriced) return null; // every spawn explicitly cheaper

  const perItem = /\b(parallel|pipeline)\s*\(/.test(src);
  const scale = perItem
    ? ' It uses parallel/pipeline — each call multiplies by the item count, so the real agent count is several times higher.'
    : '';
  const name = (src.match(/name\s*:\s*['"`]([^'"`]+)/) ?? [null, 'unnamed'])[1];

  return {
    decision: 'ask',
    reason:
      `Workflow "${name}": ${sites.length} agent spawn sites, ${unpriced} with no explicit model ` +
      `(inherit the session model)${topPriced ? `, ${topPriced} explicitly on the top model` : ''}.${scale} ` +
      'Routine stages are cheaper on a smaller model; keep the top model for judges and synthesis. Run as is?',
  };
}
