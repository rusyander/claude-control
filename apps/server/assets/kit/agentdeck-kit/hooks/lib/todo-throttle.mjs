// PreToolUse(TodoWrite): let the list be planned and finished, not narrated step by step.
//
// Measured: 632 TodoWrite calls in 21 days, ~277 tokens of input each (175k) — and every call
// rewrites the whole list, so a 20-item plan ticked off one item at a time leaves 20 near-identical
// copies sitting in the context window forever.
//
// Allowed: creating the plan, changing its shape, batched progress, the final all-done write.
// Refused: flipping exactly one status again moments after the previous write.
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

const MIN_GAP_TOOL_CALLS = 12;
const MIN_GAP_MS = 10 * 60 * 1000;

// If the user asked for the plan/status, showing it is the point.
const WANTS_PLAN = /план|todo|список задач|статус|прогресс|plan\b|checklist/i;

// Joining with NUL, not a space: two lists differing only in where the item boundaries fall must
// not hash to the same key. Built via fromCharCode so the source stays plain ASCII — a literal
// NUL in the file makes every grep treat this module as a binary blob.
const SEP = String.fromCharCode(0);

export default function todoThrottle(input) {
  if (input?.tool_name !== 'TodoWrite') return null;
  if (inSubagent(input)) return null; // the parent's list is not the child's — see inSubagent()
  const todos = input.tool_input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  const events = toolEvents(records);

  const key = (list) => list.map((t) => String(t?.content ?? '')).join(SEP);
  const sameCall = (other) =>
    Array.isArray(other?.todos) &&
    key(other.todos) === key(todos) &&
    statusKey(other.todos) === statusKey(todos);
  if (wasJustRefused(events, 'TodoWrite', sameCall)) return null;

  if (WANTS_PLAN.test(currentUserPrompt(input, records))) return null;

  // Locate the previous accepted TodoWrite and how much work happened since.
  let prev = null;
  let toolCallsSince = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'use') continue;
    if (e.name === 'TodoWrite') {
      const res = resultFor(events.slice(i), e.id);
      if (res && isRefusal(res.body)) continue; // refused, never landed
      prev = e;
      break;
    }
    toolCallsSince++;
  }
  if (!prev || !Array.isArray(prev.input?.todos)) return null; // first list of the session

  const before = prev.input.todos;
  // Shape change (items added/removed/renamed) = re-planning, always worth recording.
  if (key(before) !== key(todos)) return null;

  const changed = todos.filter((t, i) => String(t?.status) !== String(before[i]?.status)).length;
  if (changed === 0) {
    return deny('this TODO is already recorded in exactly this shape — rewriting it adds nothing.');
  }
  if (changed >= 2) return null; // batched update — exactly what we want

  const allDone = todos.every((t) => t?.status === 'completed');
  if (allDone) return null; // closing the list

  const gapMs = prev.ts ? Date.now() - prev.ts : Number.MAX_SAFE_INTEGER;
  if (toolCallsSince >= MIN_GAP_TOOL_CALLS || gapMs >= MIN_GAP_MS) return null;

  return deny(
    `TODO was updated ${toolCallsSince} calls ago and this flips one item. Every write puts a full ` +
      `copy of the list into the context — batch the ticks (2+ items, or at task end). ` +
      `Needed right now — repeat this same call.`,
  );
}

const statusKey = (list) => list.map((t) => String(t?.status ?? '')).join(SEP);
