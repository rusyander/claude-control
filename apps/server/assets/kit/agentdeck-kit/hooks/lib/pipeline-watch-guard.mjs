// A pipeline is not watched unless the user asked for it (owner rulings 31.08 + 24.09.2026; WP10 H3).
//
// Runs 70a/82b polled pipelines turn after turn and parked an undraft on them; the delivery skills now
// say «≤1 snapshot read at §12, 0 polls». A habit loses to momentum, so this gate holds the count:
//   · a Bash command that waits AROUND a pipeline read (sleep / while / until / watch / --watch) → deny;
//   · a 2nd pipeline read in one turn (since the user last typed) → deny.
// Open when the user's current prompt names the pipeline (пайплайн / pipeline / CI / джоб / job).
import {
  readTail,
  sinceLastCompact,
  currentUserPrompt,
  lastUserSpeech,
  toolEvents,
  resultFor,
  isRefusal,
  deny,
} from './transcript.mjs';
import { executedText } from './shell-text.mjs';

const MCP_READ =
  /^mcp__[^_]*gitlab[^_]*__(?:list_merge_request_pipelines|list_pipelines|get_pipeline\w*|list_pipeline_jobs|list_pipeline_trigger_jobs|get_pipeline_job\w*)$/;
// Tools that ARE a wait (block until the pipeline/job ends) — never a snapshot (owner 19.10.2026:
// groups sat for hours in them after their MR was done).
const MCP_WAIT = /^mcp__[^_]*gitlab[^_]*__(?:wait_for_pipeline|wait_for_job)$/;
const CLI_READ =
  /\b(?:glab\s+ci\s+(?:status|view|list|get|trace)|glab\s+(?:mr|pipeline)\s+\S*\s*--pipeline|gh\s+run\s+(?:watch|view|list)|gh\s+pr\s+checks)\b|\/api\/v4\/projects\/\S*\/pipelines\b/;
const WAIT = /\b(?:sleep|while|until|watch|timeout\s+\/t|Start-Sleep)\b|--watch\b/i;
// Opens only on an explicit ask: a watch/check verb next to the pipeline word, not negated. A bare
// «CI» / «job» opened it before — every group stage prompt names a CI job, so groups waited freely.
const PIPE = String.raw`(?:пайплайн|пайп|джоб|pipeline|CI\b|job\b)`;
// Wait/watch verbs only: one snapshot per turn needs no ask, so «проверь CI» opens nothing it needs.
const VERB = String.raw`(?<!\p{L})(?:подожд|дожд|жд|дожид|след|отслеж|wait|watch|track|monitor|follow)`;
const ASK_NEAR = new RegExp(
  `${VERB}[\\p{L}]*[^.!?\\n]{0,40}?${PIPE}|${PIPE}[^.!?\\n]{0,25}?${VERB}`,
  'giu',
);
// «не жди», «не нужно ждать», «don't wait», «never watch» — the verb is cut out before matching.
const NEGATED_VERB = new RegExp(
  String.raw`(?<!\p{L})(?:не|нельзя|запрещ\p{L}*|never|not|don'?t|do not|no need to)\s+(?:\p{L}+\s+)?(?:to\s+)?${VERB}\p{L}*`,
  'giu',
);

/** The prompt explicitly asks to wait for / watch the pipeline (a negated ask is a ban, not an ask). */
export function asksForPipeline(prompt) {
  ASK_NEAR.lastIndex = 0;
  return ASK_NEAR.test(String(prompt ?? '').replace(NEGATED_VERB, ' '));
}

/** Is this tool call a pipeline read? */
export function isPipelineRead(name, toolInput) {
  if (MCP_READ.test(String(name ?? '')) || MCP_WAIT.test(String(name ?? ''))) return true;
  if (!/^(Bash|PowerShell)$/.test(String(name ?? ''))) return false;
  return CLI_READ.test(executedText(String(toolInput?.command ?? '')) || '');
}

// A read that showed no pipeline is not a snapshot (L7.7, 18.10: a short sha returned `[]`, both
// retries by ref were denied, the ledger recorded skip for a pipeline that existed).
function showedNothing(res) {
  if (res.isError) return true;
  const body = String(res.body ?? '').trim();
  if (!body) return true;
  try {
    const v = JSON.parse(body);
    if (v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object')
      return Object.values(v).every((x) => x === null || (Array.isArray(x) && !x.length));
  } catch {
    // not JSON — an answer with content, not an empty one
  }
  return false;
}

/** @returns {null | {decision:'deny', reason:string}} */
export default function pipelineWatchGuard(input) {
  const name = String(input?.tool_name ?? '');
  if (!isPipelineRead(name, input?.tool_input)) return null;
  const records = sinceLastCompact(readTail(input?.transcript_path));
  if (asksForPipeline(currentUserPrompt(input, records))) return null;

  const command = executedText(String(input?.tool_input?.command ?? '')) || '';
  if (MCP_WAIT.test(name) || WAIT.test(command))
    return deny(
      'pipeline-watch Waiting for a pipeline is forbidden — the user watches CI and says so when it should be watched. ' +
        'Take at most ONE snapshot at the finish step, report its state as it is (running = «идёт», never ok); ' +
        'if commit, push, MR and review replies are done, the task is DONE — finish now.',
    );

  // Reads that returned: the in-flight call may already be flushed (no result yet), a refused one read nothing.
  const since = records.slice(lastUserSpeech(records).index + 1);
  const events = toolEvents(since);
  const earlier = events.filter((e) => {
    if (e.kind !== 'use' || !isPipelineRead(e.name, e.input)) return false;
    const res = resultFor(events, e.id);
    return Boolean(res) && !isRefusal(res.body) && !showedNothing(res);
  });
  if (!earlier.length) return null;
  return deny(
    `pipeline-watch A pipeline was already read this turn (${earlier.length}×). One snapshot per finish step, no polling: ` +
      'report the state it showed and move on. The user names the pipeline → the gate opens.',
  );
}
