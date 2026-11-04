// PostToolUse, main session: three model turns in a row that each ran ONE short read-only command
// → one line asking to batch independent reads; three in a row that each made ONE edit → the same
// for edits.
//
// Every model turn re-bills the whole context (~165k on average), so a lone `cat`/`grep`/`ls` per turn
// is the most expensive way to read. Measured week (owner audit 18.10.2026): 40% of main calls were a
// single short read-only Bash, 22.8% of all calls followed another one. Independent reads fold into one
// call (`a; b; c`) or parallel calls in one message; dependent reads stay separate — the line says so,
// because batching a read whose command depends on the previous answer acts on a guess.
// Edits (groups 20.10.2026): a work run made 60 edits one per turn, 4–6 in a row into one file, at
// ~130k context each; edits at other spots or in other files are independent and go as parallel Edit
// calls in one message.
// Throttled: at most once per 20 tool calls; silent in subagents (their context is small).
// The split-group PreToolUse refusal of lone reads is gone: the core observer reads waste in a task step.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, stateDir } from './kit-paths.mjs';
import { inSubagent, readTail } from './transcript.mjs';
import { runnable } from './rule-injector.mjs';

const RUN = 3;
const EVERY = 20;
const SHORT = 200;
const stateFile = (input) => {
  const session = sessionKey(input);
  const dir = session ? stateDir('batch-nudge') : null;
  return session && dir ? join(dir, `${session}.json`) : null;
};
const loadState = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (file, state) => {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* throttle is best effort */
  }
};

/** Tool uses grouped per model turn (one assistant message id), oldest first. */
export function turns(records) {
  const out = [];
  let lastId = null;
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const uses = (Array.isArray(r.message?.content) ? r.message.content : []).filter(
      (c) => c?.type === 'tool_use',
    );
    if (uses.length === 0) continue;
    const id = r.message?.id ?? r.uuid;
    if (id === lastId) out[out.length - 1].push(...uses);
    else out.push([...uses]);
    lastId = id;
  }
  return out;
}

// `runnable` reads cp/mv/mkdir/sed as harmless for rules, but a write breaks a run of reads here: the
// next read may depend on it. A lone git read is a read although `runnable` keeps git.
const WRITES =
  /(?:^|[\s;&|(])(?:cp|mv|mkdir|touch|rm|rmdir|tee)\s|\bsed\s+(?:-\w+\s+)*-i\b|(?<![\d&<>])>{1,2}\s*(?!&|\/dev\/null\b|nul\b)\S/i;
const GIT_READ = /^\s*git\s+(?:log|status|diff|show|branch|rev-parse|blame|ls-files)\b[^;&|<>]*$/;

export function singleShortRead(turn) {
  if (turn.length !== 1) return false;
  const [use] = turn;
  if (use.name !== 'Bash' && use.name !== 'PowerShell') return false;
  const cmd = String(use.input?.command ?? '');
  if (!cmd || cmd.length > SHORT || cmd.includes('<<') || WRITES.test(cmd)) return false;
  return GIT_READ.test(cmd) || runnable(cmd) === '';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** One turn, one edit. */
export function singleEdit(turn) {
  return turn.length === 1 && EDIT_TOOLS.has(turn[0].name);
}

/** True when the last RUN turns each made one edit. */
export function editRun(records) {
  const t = turns(records);
  if (t.length < RUN) return false;
  return t.slice(-RUN).every(singleEdit);
}

/** True when the last RUN turns were each one short read-only command. */
export function readRun(records) {
  const t = turns(records);
  if (t.length < RUN) return false;
  return t.slice(-RUN).every(singleShortRead);
}

export default function batchNudge(input) {
  const tool = input?.tool_name;
  const shell = tool === 'Bash' || tool === 'PowerShell';
  if (!shell && !EDIT_TOOLS.has(tool)) return null;
  if (inSubagent(input)) return null;
  const records = readTail(input.transcript_path, 1024 * 1024, 200);
  if (!(shell ? readRun(records) : editRun(records))) return null;
  const file = stateFile(input);
  const ids = turns(records)
    .flat()
    .map((u) => u.id);
  if (file) {
    const state = loadState(file);
    const at = state.at ? ids.lastIndexOf(state.at) : -1;
    if (at >= 0 && ids.length - 1 - at < EVERY) return null;
    saveState(file, { ...state, at: ids[ids.length - 1] });
  }
  if (!shell) {
    return (
      '[batch] 3 turns in a row each made one edit. Every turn re-bills the whole context: independent ' +
      'edits (other spots of the same file, other files) go as parallel Edit calls in ONE message. An edit ' +
      'that needs the result of the previous one stays separate.'
    );
  }
  return (
    '[batch] 3 turns in a row each ran one short read. Every turn re-bills the whole context: independent ' +
    'reads go in ONE call (`a; b; c`) or as parallel calls in one message. A read that depends on the ' +
    'previous answer stays separate.'
  );
}
