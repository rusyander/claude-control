// A pipeline is not watched unless the user asked for it.
//
// Delivery runs polled pipelines turn after turn and parked an undraft on them; the delivery skills
// now say "<=1 snapshot read at the finish step, 0 polls". A habit loses to momentum, so this gate holds the count:
//   · a Bash command that waits AROUND a pipeline read (sleep / while / until / watch / --watch) → deny;
//   · a 2nd pipeline read in one turn (since the user last typed) → deny.
// Open when the user's current prompt names the pipeline (pipeline / CI / job, or the Russian words).
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
const CLI_READ =
  /\b(?:glab\s+ci\s+(?:status|view|list|get|trace)|glab\s+(?:mr|pipeline)\s+\S*\s*--pipeline|gh\s+run\s+(?:watch|view|list)|gh\s+pr\s+checks)\b|\/api\/v4\/projects\/\S*\/pipelines\b/;
const WAIT = /\b(?:sleep|while|until|watch|timeout\s+\/t|Start-Sleep)\b|--watch\b/i;
const ASKED =
  /(?<![а-яё])(?:пайплайн|пайп|джоб)[а-яё]*|\b(?:pipeline|pipelines|CI|CI\/CD|job|jobs)\b/i;

/** Is this tool call a pipeline read? */
export function isPipelineRead(name, toolInput) {
  if (MCP_READ.test(String(name ?? ''))) return true;
  if (!/^(Bash|PowerShell)$/.test(String(name ?? ''))) return false;
  return CLI_READ.test(executedText(String(toolInput?.command ?? '')) || '');
}

/** @returns {null | {decision:'deny', reason:string}} */
export default function pipelineWatchGuard(input) {
  const name = String(input?.tool_name ?? '');
  if (!isPipelineRead(name, input?.tool_input)) return null;
  const records = sinceLastCompact(readTail(input?.transcript_path));
  if (ASKED.test(currentUserPrompt(input, records))) return null;

  const command = executedText(String(input?.tool_input?.command ?? '')) || '';
  if (WAIT.test(command))
    return deny(
      'pipeline-watch A wait around a pipeline read — the pipeline is not watched unless the user asked in this task. ' +
        'Take ONE snapshot at the finish step and report its state as it is (running = running, never ok).',
    );

  // Reads that returned: the in-flight call may already be flushed (no result yet), a refused one read nothing.
  const since = records.slice(lastUserSpeech(records).index + 1);
  const events = toolEvents(since);
  const earlier = events.filter((e) => {
    if (e.kind !== 'use' || !isPipelineRead(e.name, e.input)) return false;
    const res = resultFor(events, e.id);
    return Boolean(res) && !isRefusal(res.body);
  });
  if (!earlier.length) return null;
  return deny(
    `pipeline-watch A pipeline was already read this turn (${earlier.length}×). One snapshot per finish step, no polling: ` +
      'report the state it showed and move on. The user names the pipeline → the gate opens.',
  );
}
