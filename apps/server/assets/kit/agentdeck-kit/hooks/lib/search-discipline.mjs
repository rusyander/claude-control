// PreToolUse(Read|Grep|Glob): a long read-only sweep belongs in a subagent, not in the main window.
//
// Measured over 30 days: Read results alone are 4.4M tokens of context, Grep+Glob another 0.4M.
// Reconnaissance content stays in the window for the rest of the session and is re-billed on every
// later request, while its *conclusion* is usually a few lines. A subagent reads the same files in
// its own window and returns only the answer.
//
// Fires at most ONCE per turn, and only for a pure sweep: many read-only calls, zero edits, no
// subagent used yet. Any of those conditions failing means this is ordinary work, not recon.
//
// And only when the user allowed subagents in THIS turn's prompt: orchestration is opt-in (global
// CLAUDE.md), so without a grant "delegate" is advice the model may not follow. Ungated, 16–23.09.2026:
// 43 refusals, 39 in turns that went on to edit, 18 escaped by repeat, 1 delegation — the turn whose
// prompt had granted agents.
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  isRefusal,
  isSyntheticPrompt,
  stripReminders,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

const SWEEP_LIMIT = 12; // read-only calls in one turn before delegation is cheaper
const RECON = new Set(['Read', 'Grep', 'Glob']);
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
// Delegation already happened (or is being driven) — say nothing.
const DELEGATES = new Set(['Agent', 'Task', 'SendMessage', 'Workflow']);

// Our own marker, so a second sweep call in the same turn stays silent instead of nagging.
const MARK = 'search-discipline';

// The user can opt out of delegation for this turn, either by asking for the sweep explicitly
// or by saying they want it done inline.
const USER_OVERRIDE =
  /без\s+субагент|не\s+используй\s+субагент|сам\s+посмотри|сам\s+прочитай|вручную|no\s+subagents?\b|don'?t\s+delegate/i;

// The user handing work to agents this turn. Cyrillic needs explicit bounds (\b is ASCII-only), and
// `.agent/` paths in a prompt are not a grant.
const DELEGATION_GRANTED =
  /(?<![а-яё])(?:суб|саб)?агент(?:а|ы|ов|ам|ами|ах|у)?(?![а-яё])|параллельн|делегир|(?<![\w./-])(?:sub-?)?agents?(?![\w/-])|fan[- ]?out|\bworkflow\b|ultracode/i;

export default function searchDiscipline(input) {
  const tool = input?.tool_name;
  if (!RECON.has(tool)) return null;

  // Inside a subagent the sweep IS the delegated work — never block it there.
  if (inSubagent(input)) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  if (records.length === 0) return null;
  const events = toolEvents(records);

  const sameCall = (other) => stableKey(other) === stableKey(input.tool_input);
  if (wasJustRefused(events, tool, sameCall)) return null;

  // Only count the CURRENT turn. When the user's message is not in the parsed tail we cannot tell
  // where the turn began, so we stay silent rather than risk counting several turns as one.
  const turnStart = lastPromptIndex(records);
  if (turnStart < 0) return null;
  const turnEvents = toolEvents(records.slice(turnStart));

  const said = currentUserPrompt(input, records);
  if (USER_OVERRIDE.test(said) || !DELEGATION_GRANTED.test(said)) return null;

  let recon = 0;
  for (const e of turnEvents) {
    if (e.kind !== 'use') continue;
    if (DELEGATES.has(e.name)) return null; // already delegating this turn
    if (EDITS.has(e.name)) return null; // real work in progress, not a sweep
    if (RECON.has(e.name) && !wasRefused(turnEvents, e)) recon++;
  }
  if (recon < SWEEP_LIMIT) return null;
  if (alreadyNagged(turnEvents)) return null;

  return deny(
    `${MARK}: ${recon} read-only calls this turn with no edits — this is reconnaissance, and every ` +
      `file read stays in the window for the rest of the session. The user allowed subagents this ` +
      `turn: hand the rest to one (Explore for "where is X", general-purpose for an audit) — it reads ` +
      `in its own window, writes findings to .agent/tmp/ and returns <=10 lines. Or narrow the sweep: ` +
      `one targeted Grep, then Read with offset/limit. Genuinely need this one call inline — repeat it ` +
      `and it goes through.`,
  );
}

/** Index of the last real user message: not a tool result, not harness text, not a compact summary. */
function lastPromptIndex(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type !== 'user' || r.isCompactSummary) continue;
    const c = r.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      // A tool_result also arrives as a "user" record — those must not count as a new turn.
      if (c.some((x) => x && x.type === 'tool_result')) continue;
      text = c
        .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text)
        .join('\n');
    }
    if (!text.trim()) continue;
    if (isSyntheticPrompt(text)) continue;
    if (!stripReminders(text).trim()) continue; // a pure <system-reminder> record is harness text
    return i;
  }
  return -1;
}

/** A refused call never reached the window, so it must not count towards the sweep. */
function wasRefused(events, use) {
  const res = resultFor(events.slice(events.indexOf(use)), use.id);
  return Boolean(res && isRefusal(res.body));
}

/** Did we already ask for delegation this turn? One nudge per turn is enough. */
function alreadyNagged(events) {
  return events.some(
    (e) => e.kind === 'result' && typeof e.body === 'string' && e.body.includes(MARK),
  );
}

/** Identity of a call, used only for the "repeat it and it goes through" escape hatch. */
function stableKey(i) {
  return JSON.stringify([
    i?.file_path ?? '',
    i?.pattern ?? '',
    i?.path ?? '',
    i?.offset ?? 0,
    i?.limit ?? 0,
    i?.glob ?? '',
    i?.output_mode ?? '',
  ]);
}
