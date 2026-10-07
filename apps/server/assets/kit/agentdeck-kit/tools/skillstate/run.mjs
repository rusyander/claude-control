#!/usr/bin/env node
// SKILL.state batch runner — bounded-context execution loop for homogeneous unit batches.
// Per unit a FRESH `claude -p` worker gets (P = spec.md, Σ = compact shared state, O = the unit).
// Worker context is O(1) in batch length; knowledge crosses units only through validated state patches.
// Adapted from arXiv:2608.26263 with three deliberate deviations:
//  - unit bookkeeping (pending/done/failed) is runner-side, deterministic — a patch cannot corrupt it
//    (removes the paper's dominant failure mode: premature state overwrite, 68% of open-model errors);
//  - trajectories persist in trajectory.jsonl — dropped from CONTEXT, not from disk; retry prompts
//    inline the unit's own prior failures, so retroactive relevance stays recoverable;
//  - granularity is one UNIT per worker (real file tools), not one micro-step per LLM call.
// Usage: node run.mjs <task-dir> [--one-unit] [--max-units N] [--requeue-failed]
//   --one-unit is a TRIAL, not a preview: the worker really edits the repo and really spends quota;
//   it just stops after one unit so the diff can be inspected before the sweep. (Old name --dry-run.)
// Spend: the CLI reports an API-price estimate, but a Max subscription is billed in QUOTA, not money —
// result.json calls it est_cost_usd for exactly that reason. The budget that can actually run out is
// the subscription's rate window, and it is spent per worker.
// task-dir/: config.json, spec.md, state.json (see templates/). Outputs: trajectory.jsonl, result.json.
// Resume = rerun: state.json is the single source of truth.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PATCH_KEYS = ['decisions', 'conventions', 'blockers', 'notes'];
const CONFIG_DEFAULTS = {
  model: 'claude-sonnet-5',
  allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
  permissionMode: 'acceptEdits',
  gate: null,
  maxTurnsPerUnit: 30,
  maxRetriesPerUnit: 2,
  unitTimeoutMs: 600_000,
  maxConsecutiveFailures: 3,
  // Σ ceiling in the WORKER's prompt (chars of serialized JSON; soft — the "trimmed" marker is
  // appended after the check, so the view may exceed it by that one line). state.json keeps all —
  // only the view a worker sees is trimmed, so context stays O(1) in batch length as the paper wants.
  stateBudgetChars: 4000,
  // Passed as --effort when set (low|medium|high|xhigh); null keeps the CLI's own default. Mechanical
  // procedures rarely need more than low — measure it on the --one-unit trial before a long sweep.
  effort: null,
  // A worker that ends its turn without the result object gets resumed this many times with a note
  // naming what is missing — an unattended run otherwise loses the whole unit to one early stop.
  maxContinuations: 2,
  cli: null,
};

// The worker's answer, enforced by the CLI (--json-schema → envelope.structured_output) instead of
// fished out of free text; the fenced-block parse stays as the fallback for a CLI without it.
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    state_patch: {
      type: 'object',
      properties: {
        decisions: { type: 'object' },
        conventions: { type: 'object' },
        notes: { type: 'object' },
        blockers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    status: { type: 'string', enum: ['done', 'failed', 'blocked'] },
    summary: { type: 'string' },
  },
  required: ['state_patch', 'status', 'summary'],
  additionalProperties: false,
};

const CONTINUE_PROMPT = `You ended without the result object, so this unit has no recorded outcome yet. Finish what is still open for the current unit — run the Procedure's verification if it has not run — then answer with the result object: status "done" only after verification passed, "failed" or "blocked" otherwise, the open items named in summary.`;

// ---------- io ----------

const die = (msg) => {
  console.error(`skillstate: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
// A misspelled flag must not be swallowed: `--one_unit` silently ignored means the full sweep runs
// where a one-unit trial was meant.
const KNOWN_FLAGS = new Set(['--one-unit', '--dry-run', '--requeue-failed', '--max-units']);
const unknown = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknown.length)
  die(`unknown flag(s): ${unknown.join(' ')} — known: ${[...KNOWN_FLAGS].join(' ')}`);
if (args.includes('--dry-run'))
  console.error(
    'skillstate: --dry-run is the old name for --one-unit, and it never was a preview — the worker edits the repo for real',
  );
const ONE_UNIT = args.includes('--one-unit') || args.includes('--dry-run');
const REQUEUE = args.includes('--requeue-failed');
const maxUnitsArg = args.indexOf('--max-units');
const MAX_UNITS = maxUnitsArg >= 0 ? Number(args[maxUnitsArg + 1]) : Infinity;
if (!(MAX_UNITS > 0)) die('--max-units needs a positive number');
const taskDir = args.find(
  (a, i) => !a.startsWith('--') && !(maxUnitsArg >= 0 && i === maxUnitsArg + 1),
);
if (!taskDir) die('usage: node run.mjs <task-dir> [--one-unit] [--max-units N] [--requeue-failed]');

const p = (f) => path.join(taskDir, f);
const readJson = (f) => JSON.parse(fs.readFileSync(p(f), 'utf8'));
for (const f of ['config.json', 'spec.md', 'state.json'])
  if (!fs.existsSync(p(f)))
    die(`${f} missing in ${taskDir} — scaffold the task dir first (see templates/)`);

const cfg = { ...CONFIG_DEFAULTS, ...readJson('config.json') };
if (!cfg.repo || !fs.existsSync(cfg.repo))
  die(`config.repo missing or not a directory: ${cfg.repo}`);
const spec = fs.readFileSync(p('spec.md'), 'utf8');
let state = readJson('state.json');
// Absent key → empty list; present but not a list → stop. Coercing it silently is worse: `.length`
// on an object is undefined, the loop never turns, and the run reports ok:true having done nothing.
for (const k of ['units_pending', 'units_done', 'units_failed']) {
  if (state[k] == null) state[k] = [];
  else if (!Array.isArray(state[k]))
    die(`state.${k} must be an array, got ${typeof state[k]} — fix state.json`);
}
for (const k of ['decisions', 'conventions', 'notes']) state[k] = state[k] ?? {};
state.blockers = state.blockers ?? [];

const writeState = () => {
  fs.writeFileSync(p('state.json.tmp'), JSON.stringify(state, null, 2));
  fs.renameSync(p('state.json.tmp'), p('state.json'));
};
const traj = (rec) =>
  fs.appendFileSync(
    p('trajectory.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n',
  );
const unitId = (u) =>
  typeof u === 'string' ? u : (u?.id ?? JSON.stringify(u ?? null).slice(0, 60));
// The runner writes units_failed as {unit, status, attempts}; a hand-written or older state.json may
// hold the bare unit. Every reader unwraps through here — reading `.unit` blindly throws on the bare
// form, and in `finish` that throw would eat result.json after the whole batch had already run.
const failedUnit = (f) => (f && typeof f === 'object' && 'unit' in f ? f.unit : f);

// Failed units carry their attempt history: re-queueing by hand means unwrapping `.unit`, and a
// wrapper object handed back as a unit reaches the worker as garbage. So the runner does it.
if (REQUEUE && state.units_failed.length) {
  const back = state.units_failed.map(failedUnit);
  state.units_pending = [...back, ...state.units_pending];
  traj({ event: 'requeued', units: back.map(unitId) });
  state.units_failed = [];
  writeState();
  console.log(`skillstate: re-queued ${back.length} failed unit(s)`);
}

// ---------- worker invocation ----------

function resolveCli() {
  if (cfg.cli) return /\.(c|m)?js$/.test(cfg.cli) ? ['node', cfg.cli] : [cfg.cli];
  const wrapper = path.join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli-wrapper.cjs',
  );
  if (fs.existsSync(wrapper)) return ['node', wrapper];
  // win32 spawnSync cannot exec the npm .cmd shim without a shell; fail loud instead of half-running
  if (process.platform === 'win32')
    die('claude CLI not resolvable — set config.cli (node wrapper or exe path)');
  return ['claude'];
}
const CLI = resolveCli();

function compactState() {
  const recent = state.units_done.slice(-3).map(unitId);
  // Σ must not grow with the batch, or the "O(1) worker context" claim dies around unit 30. Over
  // budget, the OLDEST entries go first and the newest survive: a convention recorded ten units ago
  // and never referenced since is the cheapest thing to forget. Nothing is lost — state.json keeps
  // the full record, only this projection is trimmed, and the worker is told the count.
  const sigma = {
    task: state.task,
    decisions: { ...state.decisions },
    conventions: { ...state.conventions },
    blockers: state.blockers,
    notes: { ...state.notes },
    progress: {
      done: state.units_done.length,
      failed: state.units_failed.length,
      pending: state.units_pending.length,
      recent_done: recent,
    },
  };
  let dropped = 0;
  for (const section of ['notes', 'conventions', 'decisions']) {
    while (JSON.stringify(sigma).length > cfg.stateBudgetChars) {
      const oldest = Object.keys(sigma[section])[0];
      if (oldest === undefined) break;
      delete sigma[section][oldest];
      dropped++;
    }
  }
  if (dropped) {
    sigma.trimmed = `${dropped} oldest entries dropped from this view (state.json keeps them)`;
    traj({ event: 'sigma_trimmed', dropped, budget: cfg.stateBudgetChars });
  }
  return sigma;
}

function buildPrompt(unit, priorAttempts) {
  const retryBlock = priorAttempts.length
    ? '\n# Previous attempts on THIS unit (fix the cause, do not repeat them)\n' +
      priorAttempts
        .map((a, i) => `- attempt ${i + 1} [${a.status}]: ${a.summary || a.error || 'no summary'}`)
        .join('\n') +
      "\nThose attempts may have left the repo half-edited: read the unit's CURRENT state before acting, " +
      'and make every step safe to run over their leftovers rather than assuming a clean tree.\n'
    : '';
  return `[no-subagents] Work directly with your file tools; never spawn subagents (Task/Agent tools).
[return-format] Your final answer is this result object — returned as structured output; where that is unavailable, as EXACTLY one fenced \`\`\`json block at the end:
{"state_patch": {...}, "status": "done"|"failed"|"blocked", "summary": "<=2 short lines, English"}
state_patch may only touch keys: decisions, conventions, notes (objects, merged per-key, null deletes a key) and blockers (full replacement array of strings). An empty patch {} is normal. Everything you write before the block is discarded after this run — durable knowledge for later units goes into the patch, nothing else survives.

# Procedure
${spec}

# Shared state
\`\`\`json
${JSON.stringify(compactState(), null, 2)}
\`\`\`

# Current unit
\`\`\`json
${JSON.stringify(unit)}
\`\`\`
${retryBlock}
Process ONLY the current unit, following the Procedure. Verify your work as the Procedure prescribes before answering. Touch nothing outside this unit's scope. status "done" only after verification passed; "failed" if you could not complete it; "blocked" if something systemic (missing dep, broken env, permission) stops this and likely every other unit.`;
}

/**
 * The CLI's `--output-format json` envelope. Taking the last stdout LINE only holds while that
 * envelope stays single-line: one pretty-printed release, or one warning line after it, and every
 * unit of the batch dies as "unparseable". So: whole buffer first, then the last line that parses,
 * then the tail from the first brace.
 */
function parseCliEnvelope(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* not one clean object — keep looking */
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* banner or partial line — walk up */
    }
  }
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      return JSON.parse(text.slice(brace));
    } catch {
      /* give up */
    }
  }
  return null;
}

function runWorker(prompt, resumeId = null) {
  const cliArgs = [
    ...CLI.slice(1),
    '-p',
    '--output-format',
    'json',
    '--model',
    cfg.model,
    '--max-turns',
    String(cfg.maxTurnsPerUnit),
    '--strict-mcp-config',
    '--permission-mode',
    cfg.permissionMode,
  ];
  cliArgs.push('--json-schema', JSON.stringify(RESULT_SCHEMA));
  if (cfg.effort) cliArgs.push('--effort', cfg.effort);
  if (resumeId) cliArgs.push('--resume', resumeId);
  if (cfg.allowedTools?.length) cliArgs.push('--allowedTools', cfg.allowedTools.join(','));
  const t0 = Date.now();
  const r = spawnSync(CLI[0], cliArgs, {
    input: prompt,
    cwd: cfg.repo,
    encoding: 'utf8',
    timeout: cfg.unitTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const duration = Date.now() - t0;
  if (r.error)
    return {
      ok: false,
      error:
        r.error.code === 'ETIMEDOUT' ? `timeout after ${cfg.unitTimeoutMs}ms` : String(r.error),
      duration,
    };
  const res = parseCliEnvelope(r.stdout);
  if (!res)
    return {
      ok: false,
      error: `unparseable CLI output: ${(r.stdout || r.stderr || '').slice(-300)}`,
      duration,
    };
  if (res.is_error || res.subtype !== 'success')
    return {
      ok: false,
      error: `CLI ${res.subtype}: ${String(res.result ?? '').slice(-300)}`,
      duration,
      cost: res.total_cost_usd ?? 0,
    };
  return {
    ok: true,
    text: res.result ?? '',
    structured: res.structured_output ?? null,
    sessionId: res.session_id ?? null,
    cost: res.total_cost_usd ?? 0,
    turns: res.num_turns,
    duration,
  };
}

/** Structured output when the CLI enforced the schema, else the fenced block from the reply text. */
function pickResult(w) {
  if (w.structured && typeof w.structured === 'object') return { block: w.structured };
  return extractBlock(w.text);
}

// ---------- patch validation & merge ----------

function extractBlock(text) {
  const m = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!m.length) return { err: 'no fenced json block in reply' };
  try {
    return { block: JSON.parse(m[m.length - 1][1]) };
  } catch (e) {
    return { err: `fenced json unparseable: ${e.message}` };
  }
}

function validate(block) {
  if (typeof block !== 'object' || block === null) return 'reply block is not an object';
  if (!['done', 'failed', 'blocked'].includes(block.status))
    return `status must be done|failed|blocked, got: ${block.status}`;
  const patch = block.state_patch ?? {};
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    return 'state_patch must be an object';
  for (const k of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(k))
      return `state_patch key "${k}" not allowed (allowed: ${PATCH_KEYS.join(', ')})`;
    if (k === 'blockers') {
      if (!Array.isArray(patch[k]) || patch[k].some((b) => typeof b !== 'string'))
        return 'blockers must be an array of strings';
    } else if (typeof patch[k] !== 'object' || patch[k] === null || Array.isArray(patch[k])) {
      return `${k} must be an object of key→value`;
    }
  }
  return null;
}

/**
 * Knowledge from a unit that did not land is not knowledge. A worker that failed or got blocked can
 * be wrong about the very thing it just tried, and a bad "convention" in Σ steers every later worker —
 * the one corruption the runner-side bookkeeping cannot catch. So decisions/conventions/notes are
 * merged ONLY from a `done` unit; the discarded patch still sits in trajectory.jsonl, so a real
 * insight from a failed attempt is recoverable by hand.
 * Blockers are the deliberate exception: reporting a systemic obstacle is what a blocked unit is FOR.
 */
function mergePatch(patch, unit, status) {
  const discarded = [];
  for (const k of Object.keys(patch)) {
    if (k === 'blockers') {
      if (patch.blockers.length < state.blockers.length)
        traj({
          unit: unitId(unit),
          event: 'blockers_shrunk',
          from: state.blockers,
          to: patch.blockers,
        });
      state.blockers = patch.blockers;
    } else if (status !== 'done') {
      if (Object.keys(patch[k]).length) discarded.push(k);
    } else {
      for (const [key, val] of Object.entries(patch[k])) {
        if (val === null) delete state[k][key];
        else state[k][key] = val;
      }
    }
  }
  if (discarded.length)
    traj({ unit: unitId(unit), event: 'patch_discarded', status, keys: discarded });
}

// ---------- main loop ----------

const totals = { cost: 0, unitsRun: 0, started: new Date().toISOString() };
// Failures of THIS run, separate from the cumulative `state.units_failed`: a one-unit trial must judge
// the unit it just processed, not the wreckage a previous run left in the file.
const failedThisRun = [];
let consecutiveFailures = 0;
let gate = { ran: false };

while (state.units_pending.length && totals.unitsRun < MAX_UNITS) {
  const unit = state.units_pending[0];
  const id = unitId(unit);
  const attempts = [];
  let final = null; // {status, summary}

  for (let attempt = 1; attempt <= 1 + cfg.maxRetriesPerUnit; attempt++) {
    let w = runWorker(buildPrompt(unit, attempts));
    totals.cost += w.cost ?? 0;
    if (!w.ok) {
      attempts.push({ status: 'error', error: w.error });
      traj({ unit: id, attempt, status: 'error', error: w.error, duration_ms: w.duration });
      continue;
    }
    let picked = pickResult(w);
    for (let n = 1; picked.err && w.sessionId && n <= cfg.maxContinuations; n++) {
      traj({ unit: id, attempt, status: 'continued', continuation: n, reason: picked.err });
      const c = runWorker(CONTINUE_PROMPT, w.sessionId);
      totals.cost += c.cost ?? 0;
      if (!c.ok) {
        traj({ unit: id, attempt, status: 'error', continuation: n, error: c.error });
        break;
      }
      w = { ...c, cost: (w.cost ?? 0) + (c.cost ?? 0), duration: w.duration + c.duration };
      picked = pickResult(w);
    }
    const { block, err: exErr } = picked;
    const vErr = exErr ?? validate(block);
    if (vErr) {
      attempts.push({ status: 'invalid', error: vErr, summary: `validator: ${vErr}` });
      traj({
        unit: id,
        attempt,
        status: 'invalid',
        validation_error: vErr,
        duration_ms: w.duration,
        cost: w.cost,
        result_tail: w.text.slice(-800),
      });
      continue;
    }
    mergePatch(block.state_patch ?? {}, unit, block.status);
    traj({
      unit: id,
      attempt,
      status: block.status,
      summary: block.summary,
      patch: block.state_patch ?? {},
      cost: w.cost,
      turns: w.turns,
      duration_ms: w.duration,
      result_tail: w.text.slice(-800),
    });
    if (block.status === 'done') {
      final = block;
      break;
    }
    attempts.push({ status: block.status, summary: block.summary });
    if (block.status === 'blocked') {
      final = block;
      break;
    } // no point retrying systemic blocks
  }

  state.units_pending.shift();
  totals.unitsRun++;
  if (final?.status === 'done') {
    state.units_done.push(unit);
    consecutiveFailures = 0;
    console.log(
      `[${state.units_done.length}/${state.units_done.length + state.units_pending.length + state.units_failed.length}] ${id} done (~$${totals.cost.toFixed(2)} est, quota on a subscription)`,
    );
  } else {
    const status = final?.status ?? attempts.at(-1)?.status ?? 'failed';
    state.units_failed.push({ unit, status, attempts });
    failedThisRun.push({ id, status });
    consecutiveFailures++;
    console.log(`[!] ${id} ${status} after ${attempts.length || 1} attempt(s)`);
  }
  writeState();

  if (consecutiveFailures >= cfg.maxConsecutiveFailures) {
    finish(
      false,
      `aborted: ${consecutiveFailures} consecutive unit failures — inspect trajectory.jsonl and state.json, fix the cause, rerun to resume`,
    );
  }
  if (ONE_UNIT)
    finish(
      !failedThisRun.length,
      'one-unit trial: that unit is judged, the BATCH is not done — inspect the diff, then rerun without --one-unit',
    );
}

// gate + result — ok means the WHOLE batch landed: nothing pending, nothing failed, gate green
if (!state.units_pending.length && cfg.gate) {
  const g = spawnSync('bash', ['-c', cfg.gate], {
    cwd: cfg.repo,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  // g.error (no bash on PATH, timeout) leaves status null and both streams empty: without it the run
  // ends "NOT OK" with an empty gate record and nothing to debug.
  gate = {
    ran: true,
    exit: g.status,
    error: g.error ? String(g.error) : undefined,
    tail: ((g.stdout ?? '') + (g.stderr ?? '')).slice(-1200),
  };
}
finish(
  !state.units_failed.length && !state.units_pending.length && (!gate.ran || gate.exit === 0),
  state.units_pending.length
    ? `stopped with ${state.units_pending.length} unit(s) still pending`
    : undefined,
);

function finish(ok, reason) {
  const result = {
    ok,
    // `ok` answers "did what this run set out to do land?" — for a trial that is one unit, for a sweep
    // the whole batch. Reading a trial's ok:true as "batch delivered" is the mistake `mode` prevents.
    mode: ONE_UNIT ? 'one-unit' : 'batch',
    reason,
    done: state.units_done.length,
    failed: state.units_failed.map((f) => ({
      id: unitId(failedUnit(f)),
      status: f?.status ?? 'failed',
    })),
    failed_this_run: failedThisRun,
    pending: state.units_pending.length,
    gate,
    // API-price estimate the CLI returns. On a Max subscription nothing is charged in money — the
    // spend that is real, and that can run out mid-sweep, is the subscription's rate window.
    est_cost_usd: Number(totals.cost.toFixed(4)),
    started: totals.started,
    finished: new Date().toISOString(),
  };
  fs.writeFileSync(p('result.json'), JSON.stringify(result, null, 2));
  console.log(
    `skillstate: ${ok ? 'OK' : 'NOT OK'} [${result.mode}]${reason ? ` — ${reason}` : ''} | done ${result.done}, failed ${result.failed.length}, pending ${result.pending}, ~$${result.est_cost_usd} est`,
  );
  process.exit(ok ? 0 : 2);
}
