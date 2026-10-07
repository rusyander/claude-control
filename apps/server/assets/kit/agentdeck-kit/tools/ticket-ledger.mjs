#!/usr/bin/env node
/**
 * ticket-ledger — stage journal of a delivery run (skill `agentdeck-kit:ticket-delivery`).
 *
 * Why a file. The MR description and the QA comment are built from the FACTS of the run, not from
 * the agent's memory: memory survives a compaction badly and a `/clear` not at all. This is the one
 * place recording what was done and what proves it; the report quotes it instead of reconstructing
 * the run from chat scrollback.
 *
 * Why a command and not "the agent appends to a file by hand". The line is written by whoever knows
 * the exit code: `gate-run.mjs` calls `add` itself, with the real code. A line written from
 * recollection is a story, and afterwards it is indistinguishable from evidence.
 *
 *   init  <KEY> [title]                  create the ledger (a second call does not overwrite)
 *   add   <KEY> <stage> <verdict> <text> append a line; verdict ok|red|skip|stop. Refused (exit 2, nothing
 *                                        written): `11-pipeline ok` without `success` + sha or on an
 *                                        unfinished state; `13-cleanup ok` while a 10-live port listens;
 *                                        a 4th line in one minute without `late` + original evidence
 *   check <KEY>                          what is still missing; exit 1 while work is not closed
 *   path  <KEY>                          path to the file
 *
 * KEY is a tracker key (`PROJ-777`, `ABC-12`) or, when the work has no ticket at all, a slug
 * (`login-empty-state`). Several tickets in one branch: every command takes a comma-separated list —
 * `add A-1,A-2 06-gates ok "…"` writes the shared stage into EACH ledger with one call, because the
 * stop guard demands a closed ledger per key in the branch name. Per-ticket stages (the claim, the
 * QA comment) are written one key at a time. The list is validated whole before the first write;
 * `check` is red while any ledger in the list is open.
 *
 * Participants. Next to the ledger sits `<KEY>.sessions.json` — the sessions that WROTE into it
 * (`init` and `add` take the id from CLAUDE_CODE_SESSION_ID). It lets a stop guard tell the session
 * running the conveyor from a parallel one merely open in the same directory. A list, not "the last
 * writer": a run resumed after `/clear` adds itself with its first `init`, and earlier participants
 * stay under the guard.
 *
 * A `stop` verdict as the LAST line means the run was halted on purpose with a question to the user:
 * `check` then stays silent and returns zero — an open ledger is a state there, not a defect. A stop
 * the run later moved past halts nothing (hooks/lib/ticket-run.mjs reads the ledger the same way).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Project root: the git top level of the cwd, else the cwd. The ledger belongs to the project. */
function projectRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const top = r.status === 0 ? String(r.stdout || '').trim() : '';
  return top || process.cwd();
}

const ROOT = projectRoot();
const DIR = join(ROOT, '.agent', 'tickets');

/** Conveyor order. `required: false` — the stage does not apply to every ticket. */
const STAGES = [
  ['01-claim', 'ticket read, classified and claimed', true],
  ['02-branch', 'branch off a fresh trunk head', true],
  ['03-plan', 'decomposition with per-item verification', true],
  ['04-before', 'BEFORE shots', false],
  ['05-fix', 'fix written', true],
  ['06-gates', 'all applicable gates green', true],
  ['07-after', 'AFTER shots', false],
  ['08-mr', 'commit, push, draft MR', true],
  ['09-review', 'two-agent review, findings verified', true],
  ['10-live', 'live run: one positive, one negative', true],
  ['11-pipeline', 'pipeline checked and classified', true],
  ['12-finish', 'MR undrafted, QA instructions posted', true],
  ['13-cleanup', 'nothing left running', true],
];

const VERDICTS = new Set(['ok', 'red', 'skip', 'stop']);
/** How many lines sharing one minute count as a batch written afterwards. */
const BULK_FROM = 4;
/** A tracker key (PROJ-777) or, for ticket-less work, a slug (login-empty-state). */
const TRACKER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
const SLUG_RE = /^[a-z][a-z0-9-]{2,49}$/;

/** Tracker keys are upper-cased, slugs are left alone — they are two different shapes. */
function normalise(raw) {
  const t = String(raw ?? '').trim();
  return TRACKER_RE.test(t.toUpperCase()) ? t.toUpperCase() : t;
}

function keyPath(key) {
  return join(DIR, `${key}.agent.md`);
}

function sessionsPath(key) {
  return join(DIR, `${key}.sessions.json`);
}

/** Records the current session as a participant. No id in the environment — does nothing. */
function joinRun(key) {
  const session = String(process.env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!session) return;
  const file = sessionsPath(key);
  let known = [];
  try {
    known = JSON.parse(readFileSync(file, 'utf8')).sessions ?? [];
  } catch {
    // no file yet, or it is broken — start the list over
  }
  if (known.includes(session)) return;
  try {
    writeFileSync(file, JSON.stringify({ sessions: [...known, session] }), 'utf8');
  } catch {
    // the participant mark is a convenience for the guard, not a condition of the stage line
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function die(message) {
  process.stderr.write(`ticket-ledger: ${message}\n`);
  process.exit(2);
}

/** One key or a comma-separated list. A bad element rejects the whole list, before any write. */
function requireKeys(raw) {
  const list = String(raw ?? '')
    .split(',')
    .map(normalise)
    .filter(Boolean);
  const ok = (k) => TRACKER_RE.test(k) || SLUG_RE.test(k);
  if (list.length === 0 || !list.every(ok)) {
    die(
      `expected a tracker key (PROJ-777), a slug (login-empty-state) or a comma-separated list, got «${raw ?? ''}».`,
    );
  }
  return [...new Set(list)];
}

/** Ledger header. English: an agent doc, read by the model first thing when a run resumes. */
function header(key, title) {
  return [
    `# ${key}${title ? ` — ${title}` : ''}`,
    '',
    'Ledger of the delivery conveyor (skill `agentdeck-kit:ticket-delivery`), written by',
    '`<kit>/tools/ticket-ledger.mjs`. One line per gate, appended as the run goes.',
    '',
    'The MR description and the QA comment are built FROM this file: what is not written here did',
    'not happen. A run resumed after a compaction or `/clear` reads this first and continues at the',
    'first stage that has no line.',
    '',
    '## Stages',
    '',
  ].join('\n');
}

function readLedger(key) {
  const file = keyPath(key);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

/** Ledger lines as `{stage, verdict}`. Free-form notes do not reach this. */
function entries(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^- ([a-z0-9-]+) — (ok|red|skip|stop) — /i);
    if (m) out.push({ stage: m[1].toLowerCase(), verdict: m[2].toLowerCase() });
  }
  return out;
}

function cmdInit(key, title) {
  const file = keyPath(key);
  if (existsSync(file)) {
    joinRun(key);
    process.stdout.write(`ledger exists: ${file}\n`);
    return 0;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, header(key, title), 'utf8');
  joinRun(key);
  process.stdout.write(`ledger created: ${file}\n`);
  return 0;
}

/** Argument check for `add`, separate and BEFORE the write: a bad list must not leave half a line. */
function requireStage(stage, verdict) {
  const v = String(verdict ?? '').toLowerCase();
  if (!VERDICTS.has(v)) die(`verdict must be one of ${[...VERDICTS].join('|')}, got «${verdict}».`);
  if (!stage) die('no stage given.');
  return v;
}

// ---- refusals BEFORE the write: the MR text and the QA comment are built from these lines ----------
/** A pipeline snapshot that is not finished is never green (skill §11; run 70a wrote `ok` on `running`). */
const PIPE_UNFINISHED =
  /\b(?:running|pending|created|waiting_for_resource|preparing|scheduled|manual|in progress)\b/i;
/** A commit sha: 7-40 hex with at least one letter, so a bare pipeline id does not pass for one. */
const SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
/** Ports named in a `10-live` note: `port 5173`, `:5173`, `localhost:5173`. */
const PORT = /(?:\bport\s*[:=#]?\s*|(?<![\w.])(?:localhost|127\.0\.0\.1|\[::1\])?:)(\d{2,5})\b/gi;

/** Is anything accepting on this local port (IPv4 or IPv6 loopback)? */
async function listening(port) {
  const { connect } = await import('node:net');
  const probe = (host) =>
    new Promise((res) => {
      const s = connect({ host, port, timeout: 800 });
      const done = (v) => (s.destroy(), res(v));
      s.once('connect', () => done(true));
      s.once('timeout', () => done(false));
      s.once('error', () => done(false));
    });
  return (await probe('127.0.0.1')) || (await probe('::1'));
}

/** Why this line may not be written, or null. */
async function refusal(stage, v, text, body, at) {
  if (stage === '11-pipeline' && v === 'ok') {
    const unfinished = text.match(PIPE_UNFINISHED);
    if (unfinished)
      return `11-pipeline ok on an unfinished pipeline («${unfinished[0]}»): a snapshot of a running pipeline is reported as running — record \`skip\` naming state + id + time.`;
    if (!/\bsuccess\b/i.test(text) || !SHA.test(text))
      return '11-pipeline ok needs the status `success` AND the head sha it ran on in the note; anything else is `skip` naming state + id + time.';
  }
  if (stage === '13-cleanup' && v === 'ok') {
    const live =
      body
        .split('\n')
        .filter((l) => l.startsWith('- 10-live — '))
        .pop() ?? '';
    const note = live.split(' — ').slice(3).join(' — ');
    const ports = [...new Set([...note.matchAll(PORT)].map((m) => Number(m[1])))].filter(
      (p) => p > 0 && p < 65536,
    );
    const open = [];
    for (const p of ports) if (await listening(p)) open.push(p);
    if (open.length)
      return `13-cleanup ok while port ${open.join(', ')} from the 10-live note still listens: stop exactly that PID and prove the port free, or record \`13-cleanup skip "<port> kept: <why>"\`.`;
  }
  // Stages stamped in one minute mean the ledger was filled from memory at the end (run 87, 25.09.2026).
  // Three in a minute is a normal start; the fourth is refused. A line a tool witnessed as it happened
  // (gate-run sets TICKET_LEDGER_WITNESS) is exempt.
  const sameMinute = body.split('\n').filter((l) => l.includes(` — ${at} — `)).length;
  if (v !== 'stop' && !process.env.TICKET_LEDGER_WITNESS && sameMinute + 1 >= BULK_FROM) {
    const rest = text
      .replace(/\blate\b/gi, '')
      .replace(/[\s:;,.—-]+/g, ' ')
      .trim();
    if (!/\blate\b/i.test(text) || rest.length < 12)
      return (
        `${sameMinute + 1} stages in one minute (${at}) is a ledger filled afterwards; a stage is recorded WHEN it happens. ` +
        'A stage genuinely missed (crash, resume): write it from its ORIGINAL evidence — output, sha, time — with the word `late` in the note; otherwise re-run the stage.'
      );
  }
  return null;
}

async function cmdAdd(key, stage, verdict, evidence) {
  const v = requireStage(stage, verdict);
  const file = keyPath(key);
  if (!existsSync(file)) cmdInit(key, '');
  const text = evidence.join(' ').trim() || '(no evidence given)';
  const at = stamp();
  const why = await refusal(stage, v, text, readFileSync(file, 'utf8'), at);
  if (why) {
    process.stderr.write(`ticket-ledger: ${key} ${stage} ${v} refused — ${why}\n`);
    return 2;
  }
  appendFileSync(file, `- ${stage} — ${v} — ${at} — ${text}\n`, 'utf8');
  joinRun(key);
  process.stdout.write(`${key} ${stage} ${v}\n`);
  return 0;
}

function cmdCheck(key) {
  const body = readLedger(key);
  if (body === null) {
    process.stderr.write(`ticket-ledger: no ledger — ${keyPath(key)}\n`);
    return 1;
  }
  const recorded = entries(body);
  // Halted only while `stop` is the LAST line: a run that went on after the answer is open again.
  if (recorded.at(-1)?.verdict === 'stop') {
    process.stdout.write(
      `${key}: run halted on purpose (stop is the last entry) — nothing to demand\n`,
    );
    return 0;
  }
  // A stage is closed by an ok or skip line. A red line does not close it: it records an attempt.
  const done = new Set(recorded.filter((e) => e.verdict !== 'red').map((e) => e.stage));
  const missing = STAGES.filter(([id, , required]) => required && !done.has(id));
  if (missing.length === 0) {
    process.stdout.write(`${key}: ledger complete (${recorded.length} entries)\n`);
    return 0;
  }
  process.stdout.write(
    `${key}: ${missing.length} stage(s) not closed:\n` +
      missing.map(([id, what]) => `  ${id} — ${what}`).join('\n') +
      '\n',
  );
  return 1;
}

const [, , command, rawKey, ...rest] = process.argv;
/** The command over every key of the list; the exit code is the worst one seen. */
const each = (run) => Math.max(...requireKeys(rawKey).map(run));
/** Same, awaited in order: one key's refusal must not race the next key's write. */
async function eachAsync(run) {
  let worst = 0;
  for (const key of requireKeys(rawKey)) worst = Math.max(worst, await run(key));
  return worst;
}

switch (command) {
  case 'init':
    process.exit(each((key) => cmdInit(key, rest.join(' '))));
    break;
  case 'add':
    requireKeys(rawKey);
    requireStage(rest[0], rest[1]);
    process.exit(await eachAsync((key) => cmdAdd(key, rest[0], rest[1], rest.slice(2))));
    break;
  case 'check':
    process.exit(each((key) => cmdCheck(key)));
    break;
  case 'path':
    for (const key of requireKeys(rawKey)) process.stdout.write(`${keyPath(key)}\n`);
    process.exit(0);
    break;
  default:
    die('commands: init | add | check | path. Details in the file header.');
}
