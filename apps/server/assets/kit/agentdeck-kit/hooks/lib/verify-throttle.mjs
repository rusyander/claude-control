// PreToolUse(Bash|PowerShell): stop re-running the same green check after every single edit.
//
// Measured: `npx tsc --noEmit` ran 62 times in apps/web and 28 in apps/server over 21 days, plus
// typecheck/lint/test loops in the other repos. Each run is slow for the user AND leaves its whole
// output in the context window permanently.
//
// The rule is deliberately asymmetric, because the two situations are not symmetric:
//   • last run FAILED  → always allowed. Fixing errors needs a tight loop; blocking that would
//                        make the model work blind, which costs far more than it saves.
//   • last run PASSED  → allowed again only once enough edits piled up, or when the whole gate
//                        is run as one batched command (`type-check && lint && test`).
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  resultFor,
  wasJustRefused,
  deny,
  currentUserPrompt,
  inSubagent,
} from './transcript.mjs';

const MIN_EDITS_AFTER_GREEN = 4;
const STALE_MS = 30 * 60 * 1000;

// Commands that are clearly something else, even when the word "test" or "lint" appears in them.
const NOT_VERIFY =
  /^\s*(git|grep|rg|cat|ls|dir|echo|type|find|curl|node\s+-e|python\s|pip\s|which|where)\b/i;
const INSTALLING = /\b(install|add|remove|uninstall|upgrade|update|outdated|why|list)\b/i;

const VERIFY_PATTERNS = [
  /\btsc\b/i,
  /\btype-?check\b/i,
  /\bes-?lint\b/i,
  /\bstylelint\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bmocha\b/i,
  /\bdepcruise\b|\bdependency-cruiser\b/i,
  /\bplaywright\s+test\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check)\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+(?:test|clippy)\b/i,
  /\bdotnet\s+test\b/i,
];

// An explicit request from the user always wins over the guard.
const USER_ASKED =
  /прогони|запусти|проверь|прогнать|тайпчек|typecheck|type-check|тест|test|линт|lint|гейт|gate/i;

export default function verifyThrottle(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  // The parent's green run is not the child's: a subagent checking its own edit is judged against
  // the parent's transcript and would be told the check "already passed" — see inSubagent().
  if (inSubagent(input)) return null;
  const command = String(input.tool_input?.command || '');
  if (!command.trim()) return null;

  const segments = splitSegments(command);
  const verifySegments = segments.filter(isVerifySegment);
  if (verifySegments.length === 0) return null;
  // A batched gate is exactly the behaviour we want to encourage — never stand in its way.
  if (verifySegments.length >= 2) return null;

  const records = sinceLastCompact(readTail(input.transcript_path));
  const events = toolEvents(records);

  const key = normalise(command);
  const sameCall = (other) => normalise(String(other?.command || '')) === key;
  if (wasJustRefused(events, tool, sameCall)) return null;
  if (USER_ASKED.test(currentUserPrompt(input, records))) return null;

  // Find the previous run of the same check (either shell tool counts).
  let prev = null;
  let prevIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'use') continue;
    if (e.name !== 'Bash' && e.name !== 'PowerShell') continue;
    if (normalise(String(e.input?.command || '')) !== key) continue;
    prev = e;
    prevIndex = i;
    break;
  }
  if (!prev) return null; // first run of this check — always allowed

  const res = resultFor(events.slice(prevIndex), prev.id);
  if (!res) return null; // no recorded outcome — do not guess
  if (res.body && res.body.includes('[ctx-guard]')) return null; // that one was refused, not run
  if (looksFailed(res)) return null; // red → fixing loop, stay out of the way

  if (prev.ts && Date.now() - prev.ts > STALE_MS) return null; // long gap — likely a new task

  const edits = countEdits(events.slice(prevIndex));
  if (edits >= MIN_EDITS_AFTER_GREEN) return null;

  const what = edits === 0 ? 'no edits since' : `${edits} edit(s) since`;
  return deny(
    `this check already passed green this session, ${what}. Every run's output stays in the context ` +
      `for good and the run itself is slow. Batch the edits and run the gate once at task end as one ` +
      `command (type-check && lint && test) — a combined run is always allowed. ` +
      `Needed right now — repeat this same call.`,
  );
}

/** Split on && || ; and newlines so `cd x && tsc` counts the tsc part. */
function splitSegments(command) {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isVerifySegment(seg) {
  if (NOT_VERIFY.test(seg)) return false;
  if (INSTALLING.test(seg)) return false;
  return VERIFY_PATTERNS.some((re) => re.test(seg));
}

/** Normalise away redirections, pipes and whitespace so re-runs match despite cosmetic changes. */
function normalise(command) {
  return command
    .replace(/2>&1/g, ' ')
    .replace(/\|\s*(head|tail|select-string|findstr|grep|rg)\b[^|]*/gi, ' ')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksFailed(res) {
  if (res.isError) return true;
  const body = res.body || '';
  if (/^\s*Exit code [1-9]/m.test(body)) return true;
  if (/error TS\d{3,}/.test(body)) return true;
  if (/\b\d+\s+(failed|failing|errors?)\b/i.test(body) && !/\b0\s+(failed|errors?)\b/i.test(body))
    return true;
  if (/✖|\bFAIL\b/.test(body)) return true;
  return false;
}

function countEdits(events) {
  let n = 0;
  for (const e of events) {
    if (e.kind !== 'use') continue;
    if (e.name === 'Edit' || e.name === 'Write' || e.name === 'NotebookEdit') n++;
  }
  return n;
}
