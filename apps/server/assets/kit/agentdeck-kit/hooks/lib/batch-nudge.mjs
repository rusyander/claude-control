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
//
// Split group (AGENTDECK_SPLIT_CHILD=1): 595 of 1197 main messages carried ONE
// read-only call, 389 right after another (~46M cache_read at ~119k context); the PostToolUse line fired
// ~16 times — the post-any matcher skips Read/Grep/Glob, a Read turn broke the Bash-only run, and
// EVERY=20 throttled the rest. There the read run is judged at PreToolUse (`batchPre`; that matcher
// covers every read tool): Read/Grep/Glob count as reads, one line per EVERY_SPLIT calls, and after
// IGNORED_MAX lines with no batched turn between, an INDEPENDENT lone read is refused once (its key
// argument is absent from the previous result; the identical call repeated goes through). Judged on
// COMPLETED turns only: the CLI streams tool calls, so call 1 of a parallel message runs its PreToolUse
// before call 2 is written (a measured group transcript) — the in-flight turn never decides.
// A human session keeps the post path exactly as it was.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionKey, stateDir } from './kit-paths.mjs';
import {
  deny,
  inSubagent,
  readTail,
  resultFor,
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';
import { runnable } from './rule-injector.mjs';

const RUN = 3;
const EVERY = 20;
const EVERY_SPLIT = 6;
const IGNORED_MAX = 2;
const SHORT = 200;
const splitChild = () => process.env.AGENTDECK_SPLIT_CHILD === '1';
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
  // A split child judges reads at PreToolUse (`batchPre`): one line per run, not two.
  if (shell && splitChild()) return null;
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

// ── split child: the read run at PreToolUse ──

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** One turn, one read: a short read-only shell command, or (split child) a Read/Grep/Glob. */
export function loneRead(turn) {
  if (turn.length !== 1) return false;
  return READ_TOOLS.has(turn[0].name) || singleShortRead(turn);
}

/** The turns that finished: every use has its result. The in-flight turn (this call's) never decides. */
export function finishedTurns(records) {
  const events = toolEvents(records);
  const done = new Set(events.filter((e) => e.kind === 'result').map((e) => e.id));
  const all = turns(records);
  let end = all.length;
  while (end > 0 && !all[end - 1].every((u) => done.has(u.id))) end--;
  return all.slice(0, end);
}

/** What the call reads: path tails, patterns, path-like command words — matched against the last result. */
export function readKeys(tool, ti = {}) {
  const tail = (p) =>
    String(p ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() ?? '';
  if (tool === 'Read') return [tail(ti.file_path)];
  if (tool === 'Grep') return [String(ti.pattern ?? ''), tail(ti.path)];
  if (tool === 'Glob')
    return [
      String(ti.pattern ?? '')
        .replace(/[*?{}[\]]+/g, ' ')
        .trim(),
      tail(ti.path),
    ];
  const words = String(ti.command ?? '').match(/[\w.@-]*[/.][\w./@-]+/g) ?? [];
  return words.map(tail);
}

/** Independent = no key of this call (≥3 chars) appears in the previous call's result. */
export function independentOf(prevBody, tool, ti) {
  const body = String(prevBody ?? '').toLowerCase();
  const keys = readKeys(tool, ti)
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 3);
  if (keys.length === 0) return false;
  return !keys.some((k) => body.includes(k));
}

let pending = null;
/** The [batch] line `batchPre` decided on for this call, handed once to the dispatcher's context. */
export function takeNudge() {
  const text = pending;
  pending = null;
  return text;
}

const NUDGE_SPLIT =
  '[batch] 3 turns in a row each made one read. Every turn re-bills the whole context (~120k in a ' +
  'group): independent reads (Read/Grep/Glob/cat of other files or spots) go as parallel calls in ONE ' +
  'message, or one Bash `a; b; c`. A read that needs the previous answer stays separate.';

/**
 * PreToolUse, split child only: null (silence or a [batch] line left for `takeNudge`) | deny.
 * State per session: `at` = last tool id when a line went out (throttle), `ignored` = lines since the
 * last batched turn, `refusedAt` = the tool id the last refusal followed (one refusal per run).
 */
export function batchPre(input) {
  pending = null;
  if (!splitChild() || inSubagent(input)) return null;
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const isRead = READ_TOOLS.has(tool) || singleShortRead([{ name: tool, input: ti }]);
  if (!isRead) return null;
  const records = readTail(input.transcript_path, 1024 * 1024, 300);
  const done = finishedTurns(records);
  const file = stateFile(input);
  if (!file || done.length < RUN) return null;
  const state = loadState(file);
  const ids = done.flat().map((u) => u.id);
  const lastId = ids[ids.length - 1];
  // A batched turn after the last line = the line was heard; the count starts over.
  const since = state.at ? ids.lastIndexOf(state.at) : -1;
  if (since >= 0 && done.flat().length > 0) {
    const after = [];
    let seen = 0;
    for (const t of done) {
      if (seen > since) after.push(t);
      seen += t.length;
    }
    if (after.some((t) => t.length > 1)) state.ignored = 0;
  }
  if (!done.slice(-RUN).every(loneRead)) {
    if (state.ignored) saveState(file, { ...state, ignored: 0 });
    return null;
  }
  const events = toolEvents(records);
  const prev = done[done.length - 1][0];
  const prevBody = resultFor(events, prev.id)?.body ?? '';
  const same = (other) => JSON.stringify(other ?? {}) === JSON.stringify(ti);
  if (
    (state.ignored ?? 0) >= IGNORED_MAX &&
    state.refusedAt !== lastId &&
    independentOf(prevBody, tool, ti)
  ) {
    if (wasJustRefused(events, tool, same)) return null;
    saveState(file, { ...state, ignored: 0, refusedAt: lastId, at: lastId });
    return deny(
      `batch-nudge: ${RUN}+ turns in a row were one read each, after ${IGNORED_MAX} [batch] lines. This read ` +
        'does not use the previous result: send it in ONE message together with the other reads you need ' +
        'next (parallel calls), or as one Bash `a; b; c`. Repeat this identical call if it truly stands alone.',
    );
  }
  if (since >= 0 && ids.length - 1 - since < EVERY_SPLIT) {
    saveState(file, state);
    return null;
  }
  saveState(file, { ...state, at: lastId, ignored: (state.ignored ?? 0) + 1 });
  pending = NUDGE_SPLIT;
  return null;
}
