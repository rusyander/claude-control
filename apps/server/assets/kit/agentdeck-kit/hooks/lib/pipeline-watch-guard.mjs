// A pipeline is not watched unless the user asked for it (owner rulings 31.08 + 24.09.2026; WP10 H3).
//
// Runs 70a/82b polled pipelines turn after turn and parked an undraft on them; the delivery skills now
// say «≤1 snapshot read at §12, 0 polls». A habit loses to momentum, so this gate holds the count:
//   · a Bash command that waits AROUND a pipeline read (sleep / while / until / watch / --watch) → deny;
//   · a 2nd pipeline read in one turn (since the user last typed) after a snapshot that showed it still
//     going, or the identical read again → deny (a terminal snapshot's failed-job log is work);
//   · a re-read, in ANY later turn, of a pipeline an earlier read showed still running, with nothing new
//     sent to CI since (push, commit by API, new/retried pipeline) → deny.
// Open when the user's current prompt asks to wait for / watch the pipeline.
import {
  readTail,
  sinceLastCompact,
  currentUserPrompt,
  lastUserSpeech,
  userSpeech,
  toolEvents,
  resultFor,
  isRefusal,
  wasBlocked,
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

// The per-turn budget resets at every user record, and in a panel group every delivery nudge IS one:
// g3 25.10 read the same running pipeline at 12:33 and 12:36, no push between — each nudge bought a
// poll. So a snapshot that showed the pipeline still going holds across turns until something new
// reaches CI. A terminal snapshot (failed/success) does not hold: reading the failed job is work.
const ACTIVE = /\b(?:running|pending|created|preparing|waiting_for_resource|scheduled)\b/i;
const MCP_NEW_RUN =
  /^mcp__[^_]*gitlab[^_]*__(?:push_files|create_or_update_file|create_commit|create_pipeline|retry_pipeline\w*|play_pipeline_job|retry_pipeline_job|cancel_pipeline\w*)$/;
const CLI_NEW_RUN =
  /\bgit\b[^\n;&|]*?\bpush\b|\bglab\s+ci\s+(?:run|retry)\b|\bgh\s+(?:workflow\s+run|run\s+rerun)\b/;
const TARGET_KEYS = ['project_id', 'merge_request_iid', 'pipeline_id', 'job_id', 'ref', 'sha'];

function isNewRun(name, toolInput) {
  if (MCP_NEW_RUN.test(String(name ?? ''))) return true;
  if (!/^(Bash|PowerShell)$/.test(String(name ?? ''))) return false;
  return CLI_NEW_RUN.test(executedText(String(toolInput?.command ?? '')) || '');
}

/** What a read looks at: the tool + identity keys (project, MR, pipeline, ref, sha); a CLI read — its command. */
export function readTarget(name, toolInput) {
  if (/^(Bash|PowerShell)$/.test(String(name ?? '')))
    return `sh:${(executedText(String(toolInput?.command ?? '')) || '').replace(/\s+/g, ' ').trim()}`;
  const keys = TARGET_KEYS.filter((k) => toolInput?.[k] != null && toolInput[k] !== '').map((k) => {
    let v = String(toolInput[k]);
    try {
      v = decodeURIComponent(v);
    } catch {
      // a malformed escape stays as written
    }
    return `${k}=${v.toLowerCase()}`;
  });
  return `${String(name ?? '').replace(/^mcp__[^_]*gitlab[^_]*__/, '')}:${keys.join('&')}`;
}

// A user record that reports the pipeline ended is a newer snapshot than the running one (g5 25.10
// 18:49: the panel's post-done check said «pipeline failed: #11893», and four reads of the failed jobs
// were denied as polls — the group re-ran the whole frontend suite blind instead).
const ENDED = String.raw`(?:failed|failure|success(?:ful)?|succeeded|passed|canceled|cancelled|упал\p{L}*|провал\p{L}*|прош(?:ёл|ел|ла)|зел[её]н\p{L}*|красн\p{L}*)`;
function reportsEnded(text, ids) {
  return ids.some((id) =>
    new RegExp(
      `${ENDED}[^\\n]{0,60}?(?<!\\d)${id}(?!\\d)|(?<!\\d)${id}(?!\\d)[^\\n]{0,60}?${ENDED}`,
      'iu',
    ).test(text),
  );
}
const shownIds = (body) =>
  [...String(body).matchAll(/"id"\s*:\s*"?(\d{2,})|#(\d{2,})/g)].map((m) => m[1] || m[2]);

/** The earlier read of the same pipeline whose latest snapshot showed it still going, if nothing reached CI since. */
function stillGoing(records, name, toolInput) {
  const events = toolEvents(records);
  const speech = new Map(userSpeech(records).map((s) => [s.index, s.text]));
  const target = readTarget(name, toolInput);
  const id = /^\d+$/.test(String(toolInput?.pipeline_id ?? ''))
    ? String(toolInput.pipeline_id)
    : '';
  const named = id ? new RegExp(`"id"\\s*:\\s*"?${id}(?!\\d)`) : null;
  let seen = null;
  for (let i = 0; i < records.length; i++) {
    if (seen && speech.has(i) && reportsEnded(speech.get(i), id ? [id] : seen.ids)) seen = null;
    for (const e of toolEvents([records[i]])) {
      if (e.kind !== 'use') continue;
      const res = resultFor(events, e.id);
      if (!res || wasBlocked(res.body)) continue;
      if (isNewRun(e.name, e.input)) {
        seen = null;
        continue;
      }
      if (!isPipelineRead(e.name, e.input) || showedNothing(res)) continue;
      if (readTarget(e.name, e.input) !== target && !named?.test(String(res.body))) continue;
      seen = ACTIVE.test(String(res.body)) ? { ...e, ids: shownIds(res.body) } : null;
    }
  }
  return seen;
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
  // A poll is a re-read of what can still change: a snapshot that showed something going, or the identical
  // call again. After a terminal snapshot the failed job's log (page by page) is work — g5 26.10 19:22Z:
  // both reads of job 217476's log were denied, the group reran the 21-min suite blind instead.
  const events = toolEvents(since);
  const same = JSON.stringify([name, input?.tool_input ?? null]);
  const earlier = events.filter((e) => {
    if (e.kind !== 'use' || !isPipelineRead(e.name, e.input)) return false;
    const res = resultFor(events, e.id);
    if (!res || isRefusal(res.body) || showedNothing(res)) return false;
    return ACTIVE.test(String(res.body)) || JSON.stringify([e.name, e.input ?? null]) === same;
  });
  if (earlier.length)
    return deny(
      `pipeline-watch A pipeline was already read this turn (${earlier.length}×). One snapshot per finish step, no polling: ` +
        'report the state it showed and move on. The user names the pipeline → the gate opens.',
    );
  if (stillGoing(records, name, input?.tool_input))
    return deny(
      'pipeline-watch This pipeline was already read still running earlier in this conversation, and nothing new reached CI ' +
        'since (no push, no commit by API, no new or retried pipeline). A re-read is a poll: report the state that snapshot ' +
        'showed («идёт», never ok) and finish. The user asks to wait for / watch the pipeline → the gate opens.',
    );
  return null;
}
