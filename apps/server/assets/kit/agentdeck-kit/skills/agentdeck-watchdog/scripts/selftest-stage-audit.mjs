#!/usr/bin/env node
// Self-test of the stage audit path (g5 25.10 audit, W1–W4 + pause/GAP defects) through the real entry points:
// watch-groups.mjs over a fake config root and a stub panel, show.mjs --pack / --marks over the state it wrote,
// group-control.mjs pause, plus core checkKey and keepalive unrowed called directly. exit 0 = all green.
//   W1  a file the --to mark does not know is not packed whole (verify 1dfd6a07 leaked into a pack ending at fix)
//   W2  api-request* bookkeeping records never render as `--:--:--` rows
//   W3  a stage mark is the stage's own start (first record of its conversation / stageTrace at), «took» spans marks
//   W4  every conversation born mid-watch gets a mark named from its stage brief
//   pauses: a waste flag from a conversation that is over or idle arms nothing; a pause names who resumes and when;
//           UNRESUMED fires once past due, never under hold.json
//   pause by hand refuses a busy group without --s1; GAP / RERUN ignore check words inside file names and readers;
//   a ledger row citing `#u:a,b,c` cites every ref in the list
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKey, hms } from '../../watchdog/scripts/lib/core.mjs';
import { unrowed } from '../../watchdog/scripts/lib/keepalive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(here, 'watch-groups.mjs');
const CTRL = path.join(here, 'group-control.mjs');
const SHOWJS = path.join(here, '..', '..', 'watchdog', 'scripts', 'show.mjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-stage-audit-'));
const cfg = path.join(out, 'cfg');
const ad = path.join(cfg, 'agentdeck');
const repo = path.join(out, 'repo');
const ledger = path.join(repo, '.agent', 'live-watch');
fs.mkdirSync(ad, { recursive: true });
fs.mkdirSync(ledger, { recursive: true });
const credFile = path.join(out, 'cred');
fs.writeFileSync(credFile, 'stage-audit-fake\n');

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${String(detail).slice(0, 900)}`}`);
};
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_CODE_SESSION_ID;
const run = (script, args, env = {}) =>
  new Promise((done) => {
    const ch = spawn(process.execPath, [script, ...args], { env: { ...baseEnv, ...env } });
    let o = '';
    ch.stdout.on('data', (d) => (o += d));
    ch.stderr.on('data', (d) => (o += d));
    ch.on('close', (code) => done({ out: o, code }));
  });
const tagLines = (o, tag) => o.split('\n').filter((l) => new RegExp(`^\\d\\d:\\d\\d:\\d\\d \\S+ ${tag} `).test(l));
const footOf = (o, u) => o.split('\n').find((l) => l.startsWith(`${u} `) && /SAFE|busy/.test(l)) ?? '';
const tick = () => new Promise((r) => setTimeout(r, 30));

// Stub panel: records every request.
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ url: req.url, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ index: 0, stopped: 1 }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ctl = ['--base', `http://127.0.0.1:${server.address().port}`, '--token-file', credFile];

// Fake panel state and transcripts.
const P = 'p9aaaaaa-0000-1111-2222-333333333333';
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const groups = [];
const state = { splitPlans: { [P]: { parentChatId: P, groups } }, groupWatchSignals: {} };
const saveState = async () => {
  await tick();
  fs.writeFileSync(path.join(ad, 'state.json'), JSON.stringify(state));
};
const copyOf = (k) => {
  const c = path.join(out, `copy${k}`);
  fs.mkdirSync(c, { recursive: true });
  const d = path.join(cfg, 'projects', path.resolve(c).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  return { copy: c, dir: d };
};
let mid = 0;
const conv = (dir, copy, sid) => {
  const f = path.join(dir, `${sid}.jsonl`);
  const put = (at, r) => fs.appendFileSync(f, `${JSON.stringify({ sessionId: sid, cwd: copy, ...(at === null ? {} : { timestamp: iso(at) }), ...r })}\n`);
  const asst = (at, content, stop) => put(at, { type: 'assistant', message: { id: `m${++mid}`, model: 'claude-opus-5-5', stop_reason: stop, content, usage: { input_tokens: 5, cache_read_input_tokens: 100 } } });
  return {
    f,
    prompt: (at, text) => put(at, { type: 'user', message: { role: 'user', content: text } }),
    call: (at, cmd, { result = 'ok', open = false } = {}) => {
      const id = `t${++mid}`;
      asst(at, [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }], 'tool_use');
      if (!open) put(at + 500, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
      return id;
    },
    result: (at, id, content = 'ok') => put(at, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }),
    end: (at, text = 'done') => asst(at, [{ type: 'text', text }], 'end_turn'),
    raw: (r) => put(null, r),
  };
};
// Every ref a digest printed, cited as ONE list-form row per unit (`#g0:3,4,7`): the watch refuses its next call
// unless unrowed() reads each number of the list as a citation.
let rowN = 0;
const rowList = (o) => {
  const by = {};
  for (const m of o.matchAll(/#([\w.-]+):(\d+)/g)) (by[m[1]] ??= new Set()).add(m[2]);
  const rows = Object.entries(by).map(([u, ns]) => `| R-${++rowN} | now | S3 | seen | watch | #${u}:${[...ns].join(',')} | selftest | — | — | — | fixed |`);
  if (rows.length) fs.appendFileSync(path.join(ledger, 'rows.agent.md'), `${rows.join('\n')}\n`);
};

// ---- A. marks and packs (W1–W4, unknown mark, list-form rows) ---------------------------------------------
{
  const { copy, dir } = copyOf('A');
  const g = { index: 0, title: 'GA', status: 'started', path: copy, chatId: 'a1', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const a1 = conv(dir, copy, 'aaaa1111-0000-0000-0000-000000000001');
  a1.prompt(NOW - 700e3, 'Group brief: do the work');
  a1.call(NOW - 650e3, 'echo setup-call');
  const SA = path.join(out, 'stateA');
  const cA = ['--state', SA, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cA, '--group', `${P}:0`]);
  check('A setup runs', r.code === 0, r.out);
  rowList(r.out);
  // The work stage goes on after setup; an api-request-blob repeats its call with no timestamp (W2).
  a1.call(NOW - 300e3, 'echo stage-work-call');
  a1.raw({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 'Bash', input: { command: 'echo blob-dup' } }] } });
  // The review conversation starts at T1, the panel switched 10 s earlier; the watch sees it 200 s later (W3).
  const T1 = NOW - 200e3;
  const a2 = conv(dir, copy, 'bbbb2222-0000-0000-0000-000000000002');
  a2.prompt(T1, 'Group branch: b. Group tasks: X-1. This is a new session: the work was done by the model m on the branch b; read the diff and review it.');
  a2.call(T1 + 1e3, 'echo review-call');
  a2.end(T1 + 3e3, 'reviewed');
  // A record of the old conversation written after the switch belongs to the next stretch.
  a1.call(T1 + 5e3, 'echo after-review-start');
  Object.assign(g, { chatId: 'b2', stageTrace: [...g.stageTrace, { stage: 'review', at: iso(T1 - 10e3) }] });
  await saveState();
  r = await run(WATCH, [...cA, '--once']);
  check('A step 1 is not refused (a list-form row cites every ref of the list)', r.code === 0 && !/^refused:/m.test(r.out), r.out);
  rowList(r.out);
  const st1 = tagLines(r.out, 'STAGE').join(' | ');
  check('W3: STAGE with no earlier stage mark says the stage began before the watch', /work → review · work took ≥\S+ \(began before the watch\)/.test(st1), st1);
  // The verify conversation at T2; the panel calls that stage «review» again.
  const T2 = NOW - 100e3;
  const a3 = conv(dir, copy, 'cccc3333-0000-0000-0000-000000000003');
  a3.prompt(T2, 'Group branch: b. This is a new session: a review of the work found the findings below, and another session has just made fixes. Your stage is VERIFYING the fixes.');
  a3.call(T2 + 1e3, 'echo verify-call');
  a3.end(T2 + 3e3, 'verified');
  // The panel trace is 50 s early here (60 s apart from the last switch): «took» must not come from it.
  Object.assign(g, { chatId: 'c3', stageTrace: [...g.stageTrace, { stage: 'review', at: iso(T2 - 50e3) }] });
  await saveState();
  r = await run(WATCH, [...cA, '--once']);
  check('A step 2 is not refused', r.code === 0 && !/^refused:/m.test(r.out), r.out);
  rowList(r.out);
  const st2 = tagLines(r.out, 'STAGE').join(' | ');
  check('W3: «took» is the distance between the two stage marks (100 s), not the panel trace or a wake', /review → review · review took 2m,/.test(st2), st2);
  check('W3: a repeated panel stage name audits its own stretch (--from stage:review --to stage:verify)', /--pack g0 --from stage:review --to stage:verify\b/.test(st2), st2);
  r = await run(SHOWJS, ['--state', SA, '--marks', 'g0']);
  check('W3/W4: the review mark sits at the first record of its conversation', r.out.includes(`${hms(T1)} stage:review\n`), r.out);
  check('W4: the verify conversation got a mark named from its brief, at its first record', r.out.includes(`${hms(T2)} stage:verify\n`), r.out);
  check('W3: the panel name of the repeated stage is kept apart (stage:review#2)', r.out.includes(`${hms(T2)} stage:review#2\n`), r.out);
  r = await run(SHOWJS, ['--state', SA, '--pack', 'g0', '--from', 'setup', '--to', 'stage:review', '--max', '200000']);
  check('pack setup → stage:review reads the work stage', r.code === 0 && /CALL Bash \{"command":"echo stage-work-call"\}/.test(r.out), r.out);
  check('W1: a conversation born after the --to mark is not packed', !/verify-call/.test(r.out) && !/cccc3333/.test(r.out), r.out);
  check('W3: the conversation born at the --to mark belongs after it', !/review-call/.test(r.out), r.out);
  check('W3: a record of an old conversation written after the --to event is cut by its own time', !/after-review-start/.test(r.out), r.out);
  check('W2: no api-request blob row, no --:--:-- row', !/blob-dup/.test(r.out) && !/--:--:--/.test(r.out), r.out);
  r = await run(SHOWJS, ['--state', SA, '--pack', 'g0', '--from', 'stage:review', '--to', 'stage:verify', '--max', '200000']);
  check('pack stage:review → stage:verify = the review conversation + the old one after the switch, nothing before or after', /echo review-call/.test(r.out) && /echo after-review-start/.test(r.out) && !/stage-work-call/.test(r.out) && !/verify-call/.test(r.out), r.out);
  // Deliver in the same conversation (no new one): the mark is the panel's switch time, seen 40 s later.
  const T3 = NOW - 50e3;
  a3.call(T3 - 5e3, 'echo verify-late');
  a3.call(T3 + 2e3, 'echo deliver-call');
  Object.assign(g, { stageTrace: [...g.stageTrace, { stage: 'deliver', at: iso(T3) }] });
  await saveState();
  r = await run(WATCH, [...cA, '--once']);
  check('A step 3 is not refused', r.code === 0 && !/^refused:/m.test(r.out), r.out);
  rowList(r.out);
  const st3 = tagLines(r.out, 'STAGE').join(' | ');
  check('W3: a switch with no new conversation is marked at the panel trace time; «took» from the verify mark', /review → deliver · review took 50s,/.test(st3) && /--from stage:verify --to stage:deliver\b/.test(st3), st3);
  r = await run(SHOWJS, ['--state', SA, '--marks', 'g0']);
  check('W3: stage:deliver sits at the switch, not at the wake', r.out.includes(`${hms(T3)} stage:deliver\n`), r.out);
  r = await run(SHOWJS, ['--state', SA, '--pack', 'g0', '--from', 'stage:verify', '--to', 'stage:deliver', '--max', '200000']);
  check('pack stage:verify → stage:deliver = the verify conversation up to the switch', /echo verify-call/.test(r.out) && /echo verify-late/.test(r.out) && !/deliver-call/.test(r.out) && !/review-call/.test(r.out), r.out);
  r = await run(SHOWJS, ['--state', SA, '--pack', 'g0', '--from', 'stage:deliver', '--max', '200000']);
  check('pack from stage:deliver to now = the records after the switch only', /echo deliver-call/.test(r.out) && !/verify-late/.test(r.out), r.out);
  r = await run(SHOWJS, ['--state', SA, '--pack', 'g0', '--from', 'setup', '--to', 'stage:nope']);
  check('an unknown --to mark refuses with exit 2 and lists the marks', r.code === 2 && /^refused: mark not recorded for g0: --to stage:nope — recorded: setup /m.test(r.out) && !/CALL/.test(r.out), `${r.code} ${r.out}`);
}

// ---- B. pause with a resume owner, UNRESUMED --------------------------------------------------------------
{
  const { copy, dir } = copyOf('B');
  const g = { index: 1, title: 'GB', status: 'started', path: copy, chatId: 'b1', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const b1 = conv(dir, copy, 'dddd4444-0000-0000-0000-000000000004');
  b1.prompt(Date.now() - 60e3, 'Group brief');
  b1.end(Date.now() - 50e3);
  const SB = path.join(out, 'stateB');
  const cB = ['--state', SB, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  let r = await run(WATCH, [...cB, '--group', `${P}:1`]);
  check('B setup runs', r.code === 0, r.out);
  b1.prompt(Date.now() - 8e3, 'go on');
  b1.call(Date.now() - 6e3, 'cat big.log', { result: 'x'.repeat(25000) });
  b1.end(Date.now() - 2e3);
  const k = seen.length;
  r = await run(WATCH, [...cB, '--once']);
  const paused = tagLines(r.out, 'PAUSED').join(' | ');
  check('a live BIG arms and pauses the group at its safe point', seen.length === k + 1 && seen.at(-1).url.endsWith('/pause') && /for BIG big #g1:\d+/.test(paused), `${seen.length - k} ${paused} ${r.out}`);
  check('PAUSED names who resumes, when, and the command', /· resume: coordinator, once the row is fixed, due \d\d:\d\d — node \S+group-control\.mjs resume --group p9aaaaaa-0000-1111-2222-333333333333:1(?: #g1:\d+)?$/.test(paused), paused);
  g.status = 'paused';
  await saveState();
  const ws = JSON.parse(fs.readFileSync(path.join(SB, 'watch-state.json'), 'utf8'));
  check('the pause is recorded as held by the coordinator with a due time', ws.plugin?.held?.g1?.by === 'coordinator' && ws.plugin.held.g1.due > Date.now(), JSON.stringify(ws.plugin?.held));
  if (ws.plugin?.held?.g1) ws.plugin.held.g1.due = Date.now() - 1e3;
  fs.writeFileSync(path.join(SB, 'watch-state.json'), JSON.stringify(ws));
  const hold = path.join(ledger, 'hold.json');
  fs.writeFileSync(hold, JSON.stringify({ at: iso(Date.now()), reason: 'owner said stop' }));
  r = await run(WATCH, [...cB, '--once']);
  check('UNRESUMED stays silent under the owner\'s hold.json', !tagLines(r.out, 'UNRESUMED').length, r.out);
  fs.rmSync(hold);
  r = await run(WATCH, [...cB, '--once']);
  const un = tagLines(r.out, 'UNRESUMED').join(' | ');
  check('UNRESUMED fires once the due time passed and the group still stands paused', /UNRESUMED paused \S+ ago for BIG big #g1:\d+, due back \d\d:\d\d and still paused — fix the row and resume: node \S+group-control\.mjs resume --group \S+:1/.test(un), r.out);
  r = await run(WATCH, [...cB, '--once']);
  check('UNRESUMED fires once, not on every call', !tagLines(r.out, 'UNRESUMED').length, r.out);
}

// ---- C. a waste flag of a stage that is over arms nothing ----------------------------------------------------
{
  const { copy, dir } = copyOf('C');
  const g = { index: 2, title: 'GC', status: 'started', path: copy, chatId: 'c1', stageTrace: [{ stage: 'review', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const c1 = conv(dir, copy, 'eeee5555-0000-0000-0000-000000000005');
  c1.prompt(Date.now() - 40 * 60e3, 'Group brief');
  c1.end(Date.now() - 39 * 60e3);
  const SC = path.join(out, 'stateC');
  const cC = ['--state', SC, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  let r = await run(WATCH, [...cC, '--group', `${P}:2`]);
  check('C setup runs', r.code === 0, r.out);
  // g5 25.10: BIG #g5:157 read from the verify conversation idle 29 min — it paused the group for 30 min.
  c1.prompt(Date.now() - 31 * 60e3, 'go on');
  c1.call(Date.now() - 30 * 60e3, 'cat big.log', { result: 'x'.repeat(25000) });
  c1.end(Date.now() - 29 * 60e3);
  let k = seen.length;
  r = await run(WATCH, [...cC, '--once']);
  check('a BIG from a conversation idle 29 min arms nothing and pauses nothing', tagLines(r.out, 'BIG').length === 1 && !/ARMED/.test(footOf(r.out, 'g2')) && !tagLines(r.out, 'PAUSED').length && seen.length === k, `${footOf(r.out, 'g2')} ${r.out}`);
  check('the skipped arm is named, with why', /no arm for g2 by BIG #g2:\d+: the active conversation is idle 29m/.test(r.out), r.out);
  // A newer conversation runs; a waste flag of the old one (read late) arms nothing either.
  const c2 = conv(dir, copy, 'ffff6666-0000-0000-0000-000000000006');
  c2.prompt(Date.now() - 20e3, 'Group branch: b. This is a new session: the work was done by the model m; review it.');
  c2.call(Date.now() - 10e3, 'sleepless-long-call', { open: true });
  c1.call(Date.now() - 28 * 60e3, 'cat big2.log', { result: 'y'.repeat(25000) });
  k = seen.length;
  r = await run(WATCH, [...cC, '--once']);
  check('a BIG from a conversation the group already left arms nothing', tagLines(r.out, 'BIG').length === 1 && !/ARMED/.test(footOf(r.out, 'g2')) && /no arm for g2 by BIG #g2:\d+: its conversation eeee5555 is no longer the active one \(ffff6666\)/.test(r.out) && seen.length === k, `${footOf(r.out, 'g2')} ${r.out}`);
  // An arm left over from before (state of an older call) is re-checked the same way.
  const ws = JSON.parse(fs.readFileSync(path.join(SC, 'watch-state.json'), 'utf8'));
  ws.plugin.armed = { g2: { at: Date.now() - 60e3, why: 'BIG big', ref: '#g2:1', now: false, f: c1.f } };
  fs.writeFileSync(path.join(SC, 'watch-state.json'), JSON.stringify(ws));
  r = await run(WATCH, [...cC, '--once']);
  check('an existing arm whose conversation is over is dropped, and the drop is named', !/ARMED/.test(footOf(r.out, 'g2')) && /arm of g2 \(BIG big #g2:1\) dropped: its conversation eeee5555 is no longer the active one/.test(r.out), `${footOf(r.out, 'g2')} ${r.out}`);

  // ---- D. pause by hand refuses a busy group ----------------------------------------------------------------
  k = seen.length;
  r = await run(CTRL, ['pause', '--group', `${P}:2`, '--app-data', ad, '--config-root', cfg, ...ctl]);
  check('pause of a busy group (call open) is refused with no request, naming --s1 and --pause-at-safe', r.code === 1 && /^REFUSED busy: open Bash .* --s1 "<reason>".* --pause-at-safe p9aaaaaa-0000-1111-2222-333333333333:2/m.test(r.out) && seen.length === k, `${r.code} ${r.out}`);
  r = await run(CTRL, ['pause', '--group', `${P}:2`, '--app-data', ad, '--config-root', cfg, '--s1', 'burn loop eats the window', ...ctl]);
  check('--s1 "<reason>" lets the pause of a busy group through', r.code === 0 && seen.length === k + 1 && seen.at(-1).url.endsWith('/pause'), `${r.code} ${r.out}`);
  r = await run(CTRL, ['pause', '--group', `${P}:1`, '--app-data', ad, '--config-root', cfg, ...ctl]);
  check('pause of a group at a safe point goes through', r.code === 0 && seen.length === k + 2, `${r.code} ${r.out}`);
  r = await run(CTRL, ['pause', '--group', `${P}:9`, '--app-data', ad, '--config-root', cfg, ...ctl]);
  check('pause of a group the state does not know is not judged (allowed)', r.code === 0 && seen.length === k + 3, `${r.code} ${r.out}`);
}

// ---- E. GAP / RERUN: a check word inside a file name or a reader is no check ---------------------------------
{
  const cases = [
    ['sed -n 1,40p eslint.config.js || ls apps', null],
    ['grep -n FAIL tmp-vitest.log', null],
    ['cat tsconfig.json', null],
    ['echo "pnpm test"', null],
    ['git log --grep vitest', null],
    ['pnpm test 2>&1 | tail -5', 'pnpm test'],
    ['cd apps/web && npx vitest run src/a.test.ts | grep -v ok', 'vitest run src/a.test.ts'],
    ['CI=1 timeout 600 pnpm lint; echo done', 'pnpm lint'],
    ['npx eslint . && git diff --stat', 'eslint .'],
    ['pnpm type-check & pnpm lint', 'pnpm type-check && pnpm lint'],
    ['node tools/qa/check-a11y.mjs > out.log 2>&1', 'tools/qa/check-a11y.mjs'],
    ['code eslint.config.js tmp-vitest.log', null],
    ['bash -c "pnpm test; pnpm lint"', 'bash -c "pnpm test; pnpm lint"'],
    // A heredoc body is data (an edit script), not a command (g9 #g9:102 26.10: `rep(s, "import … from 'vitest'")`).
    ["cat > /tmp/rr.mjs <<'EOF'\ns = rep(s, `import { describe } from 'vitest'`);\nEOF\nnode /tmp/rr.mjs", null],
    ['cat > /tmp/t.sh <<EOF\npnpm test\nEOF\nnpx vitest run a.test.ts', 'vitest run a.test.ts'],
    // A project's own gate script is a check (g9 27.10: three `check_frontend_tests.mjs` runs, no RERUN); g5's chain
    // behind a grep head runs one too (#g5:390).
    ['node scripts/check_frontend_tests.mjs > .agent/tmp/a.log 2>&1; echo rc=$?; tail -6 .agent/tmp/a.log', 'scripts/check_frontend_tests.mjs'],
    ['cd C:/w && grep -rln "x" y | head; node scripts/check_frontend.mjs > g1.log 2>&1; echo g1=$?', 'scripts/check_frontend.mjs'],
    ['sed -n 1,40p scripts/check_frontend_tests.mjs', null],
  ];
  for (const [cmd, want] of cases) check(`checkKey(${JSON.stringify(cmd)}) = ${JSON.stringify(want)}`, checkKey(cmd) === want, JSON.stringify(checkKey(cmd)));

  const { copy, dir } = copyOf('E');
  const g = { index: 4, title: 'GE', status: 'awaiting', path: copy, chatId: 'e1', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  // The legend feed began 2 h ago (elsewhere): checks of this copy after it with no event of their own are GAPs.
  const lfeed = path.join(ad, 'verify-ledger', 'events.jsonl');
  fs.mkdirSync(path.dirname(lfeed), { recursive: true });
  fs.writeFileSync(lfeed, `${JSON.stringify({ at: NOW - 7200e3, repo: path.join(out, 'elsewhere'), check: 'vitest', key: 'k', kind: 'record', exit: 0 })}\n`);
  const e1 = conv(dir, copy, '99997777-0000-0000-0000-000000000007');
  e1.prompt(Date.now() - 20 * 60e3, 'Group brief');
  e1.end(Date.now() - 19 * 60e3);
  const SE = path.join(out, 'stateE');
  const cE = ['--state', SE, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  let r = await run(WATCH, [...cE, '--group', `${P}:4`]);
  check('E setup runs', r.code === 0, r.out);
  e1.prompt(Date.now() - 12 * 60e3, 'go on');
  e1.call(Date.now() - 10 * 60e3, 'pnpm test');
  e1.call(Date.now() - 8 * 60e3, 'sed -n 1,40p eslint.config.js || ls apps');
  e1.call(Date.now() - 7 * 60e3, 'grep -n FAIL tmp-vitest.log');
  e1.call(Date.now() - 6 * 60e3, 'cat tsconfig.json');
  // A check the legend does not cover, next to a reader naming a legend word: the legend judges the check alone.
  e1.call(Date.now() - 5.5 * 60e3, 'go test ./... ; cat vitest.config.ts');
  e1.end(Date.now() - 5 * 60e3);
  r = await run(WATCH, [...cE, '--once']);
  const gaps = tagLines(r.out, 'GAP');
  check('GAP names the real check only (#g5:206 sed eslint.config.js, #g9:36 grep tmp-vitest.log are no checks)', gaps.length === 1 && /GAP pnpm test ran/.test(gaps[0]), gaps.join(' | ') || r.out);
}

// ---- F. unrowed reads a list-form citation as each ref --------------------------------------------------------
{
  const d = path.join(out, 'ledgerF');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'g5.agent.md'), '| L-1 | 16:27 | S3 | big-read | kit | BIG #g5:95,96,101 | read | cap | — | — | fixed |\n| L-2 | 16:28 | S3 | x | — | #g5:120, 2 files | — | — | — | — | fixed |\n');
  const left = unrowed([{ ref: '#g5:95' }, { ref: '#g5:96' }, { ref: '#g5:101' }, { ref: '#g5:9' }, { ref: '#g5:2' }, { ref: '#g5:10' }], d).map((x) => x.ref);
  check('unrowed: #g5:95,96,101 cites 95, 96 and 101; nothing else is read into it', left.join(' ') === '#g5:9 #g5:2 #g5:10', left.join(' '));
  // The panel-wide unit is named «—» (restarts, STORM); a list of its refs is a list too (26.10: #—:51,52,53 cited 51 only).
  fs.writeFileSync(path.join(d, 'inbox.agent.md'), '- I-64 · — · wontfix · restarts #—:51,52,53\n');
  const dash = unrowed([{ ref: '#—:51' }, { ref: '#—:52' }, { ref: '#—:53' }, { ref: '#—:5' }], d).map((x) => x.ref);
  check('unrowed: #—:51,52,53 cites 51, 52 and 53 of the panel-wide unit', dash.join(' ') === '#—:5', dash.join(' '));
}

// ---- G. the owed-rows refusal still names a pause past due and a blind watch (g1 26.10 #g1:118) -------------
{
  const { copy, dir } = copyOf('G');
  const g = { index: 5, title: 'GG', status: 'started', path: copy, chatId: 'g5c', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const c = conv(dir, copy, 'abab7777-0000-0000-0000-000000000007');
  c.prompt(Date.now() - 60e3, 'Group brief');
  c.end(Date.now() - 50e3);
  const SG = path.join(out, 'stateG');
  const cG = ['--state', SG, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cG, '--group', `${P}:5`]);
  check('G setup runs', r.code === 0, r.out);
  rowList(r.out);
  c.prompt(Date.now() - 8e3, 'go on');
  c.call(Date.now() - 6e3, 'cat big.log', { result: 'x'.repeat(25000) });
  c.end(Date.now() - 2e3);
  r = await run(WATCH, [...cG, '--once']);
  check('G: a live BIG pauses the group at its safe point', tagLines(r.out, 'PAUSED').length === 1, r.out);
  g.status = 'paused';
  await saveState();
  // The coordinator writes the owed rows for 20 min; the pause's due time passes meanwhile.
  const wsf = path.join(SG, 'watch-state.json');
  const ws = JSON.parse(fs.readFileSync(wsf, 'utf8'));
  ws.plugin.held.g5.at = Date.now() - 25 * 60e3;
  ws.plugin.held.g5.due = Date.now() - 1e3;
  ws.lastWake = Date.now() - 20 * 60e3;
  fs.writeFileSync(wsf, JSON.stringify(ws));
  r = await run(WATCH, [...cG, '--once']);
  check(
    'G: the owed-rows refusal still names the pause past due (UNRESUMED) and the blind watch (WATCH-DARK)',
    r.code === 2 &&
      /^refused: \d+ flag/m.test(r.out) &&
      /^ {2}UNRESUMED g5: paused \S+ ago for BIG big #g5:\d+, due back \d\d:\d\d and still paused — resume now if the row judges the flag no fault, else fix and resume: node \S+group-control\.mjs resume --group \S+:5$/m.test(r.out) &&
      /^ {2}WATCH-DARK g5: no watch pass for 2\dm while it stands paused by the watch$/m.test(r.out),
    `${r.code} ${r.out}`,
  );
  const ws2 = JSON.parse(fs.readFileSync(wsf, 'utf8'));
  check('G: the refusal saves nothing — the next pass still owns its nag', !ws2.plugin.held.g5.nagged && ws2.lastWake === ws.lastWake, JSON.stringify(ws2.plugin.held));
  fs.writeFileSync(path.join(ledger, 'hold.json'), JSON.stringify({ at: iso(Date.now()), reason: 'owner said stop' }));
  r = await run(WATCH, [...cG, '--once']);
  check('G: under the owner\'s hold.json the refusal names nothing standing', r.code === 2 && !/still standing|UNRESUMED|WATCH-DARK/.test(r.out), r.out);
  fs.rmSync(path.join(ledger, 'hold.json'));
  rowList(r.out);
  r = await run(WATCH, [...cG, '--once']);
  const dark = tagLines(r.out, 'WATCH-DARK');
  check('G: the first pass after the rows flags WATCH-DARK once with its blind span, and UNRESUMED', r.code === 0 && dark.length === 1 && /no watch pass \d\d:\d\d→\d\d:\d\d \(2\dm\) while it stood paused by the watch for BIG big #g5:\d+/.test(dark[0]) && tagLines(r.out, 'UNRESUMED').length === 1, r.out);
}

// ---- H. a burn seen late, its call already returned, waits for the safe point (g1 26.10 #g1:106→118) ---------
{
  const { copy, dir } = copyOf('H');
  const g = { index: 6, title: 'GH', status: 'started', path: copy, chatId: 'h6c', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  const g7 = { ...g, index: 7, title: 'GH7', chatId: 'h7c', path: copyOf('H7').copy };
  groups.push(g, g7);
  await saveState();
  const c = conv(dir, copy, 'acac8888-0000-0000-0000-000000000008');
  c.prompt(Date.now() - 400e3, 'Group brief');
  c.end(Date.now() - 390e3);
  const SH = path.join(out, 'stateH');
  const cH = ['--state', SH, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  let r = await run(WATCH, [...cH, '--group', `${P}:6`]);
  check('H setup runs', r.code === 0, r.out);
  // The loop ran 4 min ago (the same check thrice, no edit) and ended; the watch was blind; another call runs now.
  c.prompt(Date.now() - 300e3, 'go on');
  c.call(Date.now() - 280e3, 'pnpm test');
  c.call(Date.now() - 260e3, 'pnpm test');
  c.call(Date.now() - 240e3, 'pnpm test');
  const running = c.call(Date.now() - 20e3, 'node tools/tests-cli.mjs delivery --group g6', { open: true });
  let k = seen.length;
  r = await run(WATCH, [...cH, '--once']);
  const stale = tagLines(r.out, 'PAUSE-STALE');
  const foot6 = r.out.split('\n').find((l) => l.startsWith('[g6] ')) ?? '';
  check('H: BURN is flagged', tagLines(r.out, 'BURN').length === 1, r.out);
  check('H: a burn whose call returned 4 min ago does not cut the running call', seen.length === k && !tagLines(r.out, 'PAUSED').length, `${seen.length - k} ${r.out}`);
  check('H: PAUSE-STALE names the call a pause NOW would have cut, and the arm waits for the safe point', stale.length === 1 && /BURN rerun #g6:\d+ flagged 4m ago and its call already returned — a pause NOW would cut Bash '?node tools\/tests-cli\.mjs delivery/.test(stale[0]) && /ARMED pause at safe point \(BURN rerun #g6:\d+\)/.test(foot6), `${stale.join(' | ')} · ${foot6}`);
  c.result(Date.now() - 2e3, running);
  c.end(Date.now() - 1e3);
  r = await run(WATCH, [...cH, '--once']);
  check('H: the downgraded burn pauses at the safe point', seen.length === k + 1 && tagLines(r.out, 'PAUSED').some((l) => /at safe point .* for BURN rerun #g6:\d+/.test(l)), `${seen.length - k} ${r.out}`);
  // Control: the same old loop with its last call still open is the loop running now — pause NOW.
  const d7 = copyOf('H7').dir;
  const c7 = conv(d7, g7.path, 'adad9999-0000-0000-0000-000000000009');
  c7.prompt(Date.now() - 400e3, 'Group brief');
  c7.end(Date.now() - 390e3);
  const SH7 = path.join(out, 'stateH7');
  const cH7 = ['--state', SH7, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  r = await run(WATCH, [...cH7, '--group', `${P}:7`]);
  check('H7 setup runs', r.code === 0, r.out);
  // Open 140 s: past BURN_LIVE_MS, short of the STALL a Bash past its own timeout raises (120 s + 60 s).
  c7.prompt(Date.now() - 170e3, 'go on');
  c7.call(Date.now() - 160e3, 'pnpm test');
  c7.call(Date.now() - 150e3, 'pnpm test');
  c7.call(Date.now() - 140e3, 'pnpm test', { open: true });
  k = seen.length;
  r = await run(WATCH, [...cH7, '--once']);
  check('H7: an old burn whose call is still open pauses NOW', seen.length === k + 1 && tagLines(r.out, 'PAUSED').some((l) => /NOW, mid-turn for BURN rerun #g7:\d+/.test(l)) && !tagLines(r.out, 'PAUSE-STALE').length, `${seen.length - k} ${r.out}`);
}

// ---- I. a pause made after a long gap is not a blind pause (g1 26.10 #g1:146) -------------------------------
{
  const { copy, dir } = copyOf('I');
  const g = { index: 8, title: 'GI', status: 'awaiting', waitingFor: 'delivery', path: copy, chatId: 'i8c', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const c = conv(dir, copy, 'aeae1111-0000-0000-0000-000000000011');
  c.prompt(Date.now() - 60e3, 'Group brief');
  c.end(Date.now() - 50e3);
  const SI = path.join(out, 'stateI');
  const cI = ['--state', SI, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cI, '--group', `${P}:8`]);
  check('I setup runs', r.code === 0, r.out);
  rowList(r.out);
  c.prompt(Date.now() - 8e3, 'go on');
  c.call(Date.now() - 6e3, 'cat big.log', { result: 'x'.repeat(25000) });
  c.end(Date.now() - 2e3);
  // The watch was away 50 min before this call (rows, fixes); the call pauses and then sees the group paused.
  const wsf = path.join(SI, 'watch-state.json');
  const ws = JSON.parse(fs.readFileSync(wsf, 'utf8'));
  ws.lastWake = Date.now() - 50 * 60e3;
  fs.writeFileSync(wsf, JSON.stringify(ws));
  r = await run(WATCH, [...cI, '--once']);
  check('I: the BIG pauses the group at its safe point', tagLines(r.out, 'PAUSED').length === 1, r.out);
  rowList(r.out);
  g.status = 'paused';
  delete g.waitingFor;
  await saveState();
  const ws2 = JSON.parse(fs.readFileSync(wsf, 'utf8'));
  ws2.lastWake = ws.lastWake;
  fs.writeFileSync(wsf, JSON.stringify(ws2));
  r = await run(WATCH, [...cI, '--once']);
  check('I: the gap before the pause is no blind pause — no WATCH-DARK', r.code === 0 && !tagLines(r.out, 'WATCH-DARK').length, r.out);
}

// ---- J. a group waiting for the human is not paused: nothing runs, the pause would cost a turn (#g1:144) ----
{
  const { copy, dir } = copyOf('J');
  const g = { index: 9, title: 'GJ', status: 'awaiting', waitingFor: 'mr-red', path: copy, chatId: 'j9c', stageTrace: [{ stage: 'deliver', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const c = conv(dir, copy, 'afaf2222-0000-0000-0000-000000000012');
  c.prompt(Date.now() - 60e3, 'Group brief');
  c.end(Date.now() - 50e3);
  const SJ = path.join(out, 'stateJ');
  const cJ = ['--state', SJ, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cJ, '--group', `${P}:9`]);
  check('J setup runs', r.code === 0, r.out);
  rowList(r.out);
  c.prompt(Date.now() - 8e3, 'red pipeline');
  c.call(Date.now() - 6e3, 'cat big.log', { result: 'x'.repeat(25000) });
  c.end(Date.now() - 2e3);
  let k = seen.length;
  r = await run(WATCH, [...cJ, '--once']);
  const foot = r.out.split('\n').find((l) => l.startsWith('[g9] ')) ?? '';
  check('J: awaiting(mr-red) at a safe point is not paused, the arm stays', seen.length === k && !tagLines(r.out, 'PAUSED').length && /ARMED pause at safe point \(BIG/.test(foot), `${seen.length - k} ${foot} ${r.out}`);
  rowList(r.out);
  // Control: the same arm on a group the panel itself moves (awaiting delivery) pauses.
  g.waitingFor = 'delivery';
  await saveState();
  k = seen.length;
  r = await run(WATCH, [...cJ, '--once']);
  check('J: the same arm pauses once the wait is not the human\'s', seen.length === k + 1 && tagLines(r.out, 'PAUSED').length === 1, `${seen.length - k} ${r.out}`);
}

// ---- K. the MR recheck conversation is a stretch of its own (W1, g5 27.10: no mark, the pack began 1m45s in) ----
const RECHECK = (title) => `This is a NEW conversation of the split group «${title}»: the panel starts every MR recheck fresh instead of resuming the old session. Your previous conversation (old) stays in the chat history — do not try to resume or continue it.\n\nThe group's task, as it was given:\nreview the merge request comments and fix them`;
{
  // K1: the watch starts while the recheck already runs — its file is seeded at the tail, core never sees it born.
  const { copy, dir } = copyOf('K1');
  const g = { index: 10, title: 'GK1', status: 'started', path: copy, chatId: 'k1b', stageTrace: [{ stage: 'deliver', at: iso(NOW - 26 * 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const old = conv(dir, copy, 'abab1010-0000-0000-0000-000000000013');
  old.prompt(NOW - 26 * 3600e3, 'Group branch: b. Your stage is delivering: push and open the MR.');
  old.call(NOW - 26 * 3600e3 + 60e3, 'echo deliver-tail');
  old.end(NOW - 26 * 3600e3 + 90e3);
  // A day-old transcript was last written a day ago: written in the same millisecond as the recheck file, the two
  // tied on mtime and the newest-file pick fell to the old delivery (a flake, 27.10).
  const oldAt = new Date(NOW - 26 * 3600e3 + 90e3);
  fs.utimesSync(old.f, oldAt, oldAt);
  const TK = Date.now() - 105e3;
  const rc = conv(dir, copy, 'abab1010-0000-0000-0000-000000000014');
  rc.prompt(TK, RECHECK('GK1'));
  rc.call(TK + 1e3, 'echo recheck-early');
  const SK = path.join(out, 'stateK1');
  const cK = ['--state', SK, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cK, '--group', `${P}:10`]);
  check('K1 setup runs', r.code === 0, r.out);
  rowList(r.out);
  r = await run(SHOWJS, ['--state', SK, '--marks', 'g10']);
  check('W1: a recheck running at setup gets stage:recheck at its first record, before setup', new RegExp(`^${hms(TK)} stage:recheck\\n[\\s\\S]*setup$`, 'm').test(r.out), r.out);
  r = await run(SHOWJS, ['--state', SK, '--pack', 'g10', '--from', 'stage:recheck', '--max', '200000']);
  check('W1: the recheck pack starts at offset 0 of its conversation (the call before setup is in, the old delivery is not)', /echo recheck-early/.test(r.out) && !/deliver-tail/.test(r.out), r.out);
  rc.call(Date.now() - 2e3, 'echo recheck-late');
  rc.end(Date.now() - 1e3);
  Object.assign(g, { status: 'done', mr: 'https://tracker.example.com/merge_requests/7' });
  await saveState();
  r = await run(WATCH, [...cK, '--once']);
  const ended = tagLines(r.out, 'ENDED').join(' | ');
  check('W1: ENDED after a recheck audits the recheck stretch (--from stage:recheck --to ended)', /review: watch audit g10 recheck/.test(ended) && /--pack g10 --from stage:recheck --to ended\b/.test(ended), ended || r.out);
  rowList(r.out);
  r = await run(SHOWJS, ['--state', SK, '--pack', 'g10', '--from', 'stage:recheck', '--to', 'ended', '--max', '200000']);
  check('W1: that pack holds the whole recheck and nothing of the delivery a day before', /recheck-early/.test(r.out) && /recheck-late/.test(r.out) && !/deliver-tail/.test(r.out), r.out);
}
{
  // K2: a recheck born mid-watch after a delivery stage switch: named from its brief (not «review the merge
  // request» inside its task), and ENDED audits from it, not from the earlier stage:deliver.
  const { copy, dir } = copyOf('K2');
  const g = { index: 11, title: 'GK2', status: 'started', path: copy, chatId: 'k2a', stageTrace: [{ stage: 'work', at: iso(NOW - 3600e3) }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
  groups.push(g);
  await saveState();
  const w = conv(dir, copy, 'acac1111-0000-0000-0000-000000000015');
  w.prompt(Date.now() - 60e3, 'Group brief');
  w.end(Date.now() - 50e3);
  const SK2 = path.join(out, 'stateK2');
  const cK2 = ['--state', SK2, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--ledger-dir', ledger, ...ctl];
  let r = await run(WATCH, [...cK2, '--group', `${P}:11`]);
  check('K2 setup runs', r.code === 0, r.out);
  rowList(r.out);
  const TD = Date.now() - 20e3;
  const d = conv(dir, copy, 'acac1111-0000-0000-0000-000000000016');
  d.prompt(TD, 'Group branch: b. Your stage is delivering: push and open the MR.');
  d.call(TD + 1e3, 'echo deliver-call');
  d.end(TD + 2e3);
  Object.assign(g, { chatId: 'k2d', stageTrace: [...g.stageTrace, { stage: 'deliver', at: iso(TD - 1e3) }] });
  await saveState();
  r = await run(WATCH, [...cK2, '--once']);
  rowList(r.out);
  const TR = Date.now() - 5e3;
  const rc = conv(dir, copy, 'acac1111-0000-0000-0000-000000000017');
  rc.prompt(TR, RECHECK('GK2'));
  rc.call(TR + 1e3, 'echo recheck-born');
  rc.end(TR + 2e3);
  Object.assign(g, { status: 'done', chatId: 'k2r' });
  await saveState();
  r = await run(WATCH, [...cK2, '--once']);
  const ended = tagLines(r.out, 'ENDED').join(' | ');
  rowList(r.out);
  const marks = (await run(SHOWJS, ['--state', SK2, '--marks', 'g11'])).out;
  check('W1: a recheck born mid-watch is marked stage:recheck at its first record, never stage:mr-review', marks.includes(`${hms(TR)} stage:recheck\n`) && !/mr-review/.test(marks), marks);
  check('W1: ENDED takes the recheck, later than the stage:deliver mark, as the stretch start', /--pack g11 --from stage:recheck --to ended\b/.test(ended), ended || r.out);
}

server.close();
fs.rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
