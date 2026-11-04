// PostToolUse, deep-review LANE subagents only: the context cap of the lane brief, and a batch line for
// serial reads. Silent everywhere else (main thread, every other subagent).
//
// Why: a lane's brief says «Context cap ≈Nk … Past ≈Nk, hand back at once — the ledger as it stands, the
// unread chunks named in your return (`check` makes them RERUN rounds)». Measured 03.11.2026: 256 of 269
// lanes ran past it, median peak 134k, and they made ~1.09 tool calls per turn. Every turn re-bills the
// whole context, so the cost is Σ per-turn context: both the peak and the number of turns count. The
// main-session batch-nudge stays silent in subagents (its premise "their context is small" is false for
// lanes), so this module carries the lane variant.
//
// Lane = the subagent's own `.meta.json` description `deep-review r<k> lane <id>` (464 of 464 subagent
// transcripts had a meta, 03.11.2026); without a meta, a first user message opening `Your full brief is
// …lane-<id>-r<k>.prompt.md` (the stub the planner spawns with). The hook input of a
// subagent carries `agent_id` and the PARENT's transcript_path; `ownTranscript` resolves the child file.
//
// 1. Cap: context = input + cache_creation + cache_read of the last assistant message (records of one
//    message.id repeat the same usage). Cap = brief's «Context cap ≈Nk», else 95k; env LANE_CONTEXT_CAP
//    (`95k` | `95` | `95000`) overrides both. ≥cap → one line; ≥cap+25k → one firmer line. An owner
//    override in the brief («NO rerun rounds», «read ALL chunks», «Never hand back early») silences it.
// 2. Batch: the last 3 turns each one read call (Read/Grep/Glob or a read-only shell command) → one
//    line, at most once per 15 tool calls. Runs under an owner override too: batching costs no chunks.
//
// State per lane transcript in <kit state>/lane-budget/<agent id>.json (kit-paths stateDir): identification + cap read once, the
// fired flags, the throttle mark. Transcript read = a 512 KB tail (records ≤ ~90 KB), the head once.
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from './kit-paths.mjs';
import { inSubagent, ownTranscript, readTail } from './transcript.mjs';
import { turns } from './batch-nudge.mjs';
import { runnable } from './rule-injector.mjs';

export const DEFAULT_CAP = 95_000; // = review-plan LANE_CONTEXT
export const FIRM_STEP = 25_000;
const RUN = 3;
const EVERY = 15;
const HEAD_BYTES = 256 * 1024;
const BRIEF_BYTES = 200 * 1024;

const LANE_DESC = /^deep-review r\d+ lane\b/i;
const STUB = /lane-[\w.-]+-r\d+\.prompt\.md/i;
const STUB_OPENING = /^\s*Your full brief is\s/i;
const CAP_LINE = /Context cap\s*≈?\s*(\d+(?:\.\d+)?)\s*k\b/i;
const OVERRIDE = /\bNO rerun rounds\b|\bread ALL chunks\b|\bnever hand back early\b/i;

// ── identification ──

/** First line of a file (the spawn prompt record), '' on any problem. Reads the head only. */
function headLine(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Text of the first user message; falls back to the raw head when it is cut mid-record. */
export function firstMessage(line) {
  try {
    const c = JSON.parse(line)?.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c))
      return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
    return '';
  } catch {
    return String(line ?? '');
  }
}

/** Absolute path of the lane brief named in the stub, null when none. MSYS `/c/…` → `C:/…`. */
export function briefPath(text) {
  const m = String(text ?? '').match(new RegExp(`[^\\s"'\`<>|]*${STUB.source}`, 'i'));
  if (!m) return null;
  return m[0].replace(/^\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`);
}

/** Cap in tokens from the brief text, the env override first; null = no cap line. */
export function capOf(brief, env = process.env) {
  const forced = String(env.LANE_CONTEXT_CAP ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(k)?$/i);
  if (forced) {
    const v = Number(forced[1]);
    return forced[2] || v < 1000 ? Math.round(v * 1000) : Math.round(v);
  }
  const m = String(brief ?? '').match(CAP_LINE);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export function hasOverride(brief) {
  return OVERRIDE.test(String(brief ?? ''));
}

const readText = (path, max) => {
  try {
    const s = readFileSync(path, 'utf8');
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return null;
  }
};

/**
 * {lane, cap, override} for a subagent transcript, or null when it cannot be told yet (nothing
 * written) — then nothing is cached and the next call asks again.
 */
export function identify(own) {
  let desc = null;
  try {
    desc = String(
      JSON.parse(readFileSync(own.replace(/\.jsonl$/i, '.meta.json'), 'utf8'))?.description ?? '',
    );
  } catch {
    /* no meta (yet) — the stub decides */
  }
  const first = firstMessage(headLine(own));
  if (!first && desc === null) return null;
  const stub = briefPath(first);
  // The meta description decides when present: the planner subagent («deep-review plan …») also names
  // lane prompt files in its spawn prompt. Without meta only the planner's stub opening counts.
  const lane = desc ? LANE_DESC.test(desc) : Boolean(stub) && STUB_OPENING.test(first);
  if (!lane) return { lane: false };
  // Stub lanes keep the brief in its own file; older lanes carried it inline in the spawn prompt.
  const brief = (stub && readText(stub, BRIEF_BYTES)) ?? first;
  return { lane: true, cap: capOf(brief) ?? DEFAULT_CAP, override: hasOverride(brief) };
}

// ── context ──

/** Context of the last assistant message: input + cache_creation + cache_read; 0 when none. */
export function currentContext(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const u = r?.type === 'assistant' ? r.message?.usage : null;
    if (!u) continue;
    return (
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    );
  }
  return 0;
}

// ── reads ──

// A write breaks a read run: the next read may depend on it (same set as batch-nudge).
const WRITES =
  /(?:^|[\s;&|(])(?:cp|mv|mkdir|touch|rm|rmdir|tee)\s|\bsed\s+(?:-\w+\s+)*-i\b|(?<![\d&<>])>{1,2}\s*(?!&|\/dev\/null\b|nul\b)\S/i;
// Lanes read through `git -C <tree> show|diff|grep …` and `cd <clone> && …`: both count as reads.
const GIT_READ =
  /\bgit\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?(?:--no-pager\s+)?(?:log|status|diff|show|branch|rev-parse|blame|ls-files|ls-tree|grep|cat-file|merge-base)\b/g;
const CD = /(^|&&|;|\n)\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?=&&|;|\n|$)/g;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** One read: Read/Grep/Glob, or a shell command with no write and nothing but read-only programs. */
export function isRead(use) {
  if (READ_TOOLS.has(use?.name)) return true;
  if (use?.name !== 'Bash' && use?.name !== 'PowerShell') return false;
  const cmd = String(use.input?.command ?? '');
  if (!cmd || cmd.includes('<<') || WRITES.test(cmd)) return false;
  return runnable(cmd.replace(GIT_READ, 'cat').replace(CD, '$1')) === '';
}

/** The last RUN turns (the current one included) each made exactly one read call. */
export function serialReads(allTurns) {
  return (
    allTurns.length >= RUN && allTurns.slice(-RUN).every((t) => t.length === 1 && isRead(t[0]))
  );
}

// ── state ──

const stateFile = (own) => {
  const agent = own.match(/agent-([\w-]+)\.jsonl$/i)?.[1];
  const key = agent ?? createHash('sha1').update(own).digest('hex').slice(0, 16);
  const dir = stateDir('lane-budget');
  return dir ? join(dir, `${key}.json`) : null;
};
const loadState = (file) => {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (file, state) => {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* best effort: a lost write repeats a line at worst */
  }
};

// ── messages ──

const k = (n) => `≈${Math.round(n / 1000)}k`;
export const capLine = (ctx, cap) =>
  `[lane-budget] Context ${k(ctx)} has reached this lane's cap ${k(cap)}. Hand back now: bring the deliverable ` +
  'current (ledger rows, candidates), then return and name every unread chunk, so `review-plan check` makes ' +
  'them RERUN rounds that start at a small context.';
export const firmLine = (ctx, cap) =>
  `[lane-budget] Context ${k(ctx)} is ${k(ctx - cap)} past this lane's cap ${k(cap)}. Hand back in this turn: ` +
  'save the deliverable as it stands and list the unread chunks for RERUN rounds; each further turn re-bills ' +
  'the whole context.';
export const BATCH_LINE =
  '[lane-batch] 3 turns in a row each made one read. Put every independent read/search of the next step into ' +
  'ONE message (parallel calls, or one Bash `a; b; c`); a read that needs the previous answer goes next.';

// ── module ──

export default function laneBudget(input) {
  if (!inSubagent(input)) return null;
  const own = ownTranscript(input);
  if (!/[\\/]subagents[\\/]/.test(own) || !existsSync(own)) return null;
  const file = stateFile(own);
  const state = loadState(file);
  if (state.lane === undefined) {
    const id = identify(own);
    if (!id) return null;
    Object.assign(state, id);
    saveState(file, state);
  }
  if (!state.lane) return null;

  const records = readTail(own, 512 * 1024, 300);
  const out = [];
  let dirty = false;

  if (!state.override) {
    const ctx = currentContext(records);
    const cap = capOf('', process.env) ?? state.cap ?? DEFAULT_CAP;
    if (ctx >= cap + FIRM_STEP && !state.firm) {
      out.push(firmLine(ctx, cap));
      state.firm = true;
      state.capped = true;
      dirty = true;
    } else if (ctx >= cap && !state.capped) {
      out.push(capLine(ctx, cap));
      state.capped = true;
      dirty = true;
    }
  }

  const all = turns(records);
  // The current call's turn must be the newest one; a parallel turn of the current message is batched.
  const current = all[all.length - 1] ?? [];
  const isCurrent = !input?.tool_use_id || current.some((u) => u.id === input.tool_use_id);
  if (isCurrent && serialReads(all)) {
    const ids = all.flat().map((u) => u.id);
    const at = state.batchAt ? ids.lastIndexOf(state.batchAt) : -1;
    if (at < 0 || ids.length - 1 - at >= EVERY) {
      out.push(BATCH_LINE);
      state.batchAt = ids[ids.length - 1];
      dirty = true;
    }
  }

  if (dirty) saveState(file, state);
  return out.length ? out.join('\n\n') : null;
}
