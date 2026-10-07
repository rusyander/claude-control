// PreToolUse(Read): keep re-reads out of the context window.
//
// Measured on 21 days of transcripts: 20% of all Read calls were the same file read again in the
// same session (50% in the longest one). The content is still in the window — re-reading pays for
// it twice and is a symptom of an overloaded session, not a need.
//
// Scope note: whole-file size is NOT handled here. `doc-size-guard` already denies whole reads
// above 30 KB; duplicating that check would only produce two refusals for one call.
import { statSync } from 'node:fs';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  isRefusal,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

// Read renders these visually or paginates them itself.
const OPAQUE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb)$/i;

// An explicit "read it again" from the user outranks the guard.
// Word-bounded on purpose: a bare /again/ also matches "against", and one stray word in a long
// user message must not switch the guard off for the rest of the session.
const WANTS_REREAD = /перечитай|заново|ещё раз|еще раз|\bre-?read\b|\bagain\b/i;

const norm = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();
const rangeOf = (input) => `${input?.offset ?? 0}:${input?.limit ?? 0}`;

export default function readDiscipline(input) {
  if (input?.tool_name !== 'Read') return null;
  // A subagent is handed the PARENT's transcript: judged against it, the child's first read of a file
  // is "already read" and the repeat escape never opens (40 false refusals, 0 genuine — 18.09.2026).
  if (inSubagent(input)) return null;
  const filePath = input.tool_input?.file_path;
  if (!filePath || OPAQUE.test(filePath)) return null;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null; // missing file — let Read produce the real error
  }
  if (!stat.isFile()) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  if (records.length === 0) return null; // no history to judge against
  const events = toolEvents(records);

  const sameCall = (other) =>
    norm(other?.file_path) === norm(filePath) && rangeOf(other) === rangeOf(input.tool_input);
  if (wasJustRefused(events, 'Read', sameCall)) return null;
  if (WANTS_REREAD.test(currentUserPrompt(input, records))) return null;

  const previous = lastSuccessfulRead(events, filePath);
  if (!previous || !previous.ts) return null;
  // Any write to the file — by us or by anyone else — makes a re-read legitimate.
  if (stat.mtimeMs > previous.ts) return null;

  // A wider slice than last time is new information; a narrower or identical one is not.
  if (!coveredBy(previous.input, input.tool_input)) return null;

  const scope = previous.input.limit
    ? `lines ${previous.input.offset ?? 1}-${(previous.input.offset ?? 1) + previous.input.limit}`
    : 'whole file';
  return deny(
    `${shortName(filePath)} was already read this session (${scope}) and has not changed since — ` +
      `the content is still in the context above, find it there. Need a different part: Read with ` +
      `another offset/limit, or Grep. Genuinely need it again — repeat this same call.`,
  );
}

/** True when the earlier read already covers everything the new one asks for. */
function coveredBy(prev, next) {
  if (!prev.limit) return true; // previous read took the whole file
  if (!next?.limit) return false; // now asking for the whole file — genuinely more
  const prevStart = prev.offset ?? 1;
  const nextStart = next.offset ?? 1;
  return nextStart >= prevStart && nextStart + next.limit <= prevStart + prev.limit;
}

function shortName(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/**
 * Most recent Read of this path that actually returned content.
 * A failed read (missing file, permission error, or our own refusal) must never count as
 * "you already have it".
 */
function lastSuccessfulRead(events, filePath) {
  const target = norm(filePath);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'use' || e.name !== 'Read') continue;
    if (norm(e.input?.file_path) !== target) continue;
    const res = resultFor(events.slice(i), e.id);
    if (!res || res.isError) continue;
    if (isRefusal(res.body)) continue;
    return { input: e.input || {}, ts: e.ts };
  }
  return null;
}
