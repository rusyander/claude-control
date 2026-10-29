#!/usr/bin/env node
// Self-test of watch-groups.mjs and group-control.mjs through their real entry points: a fake config root
// (state.json, transcripts, dev-watch files), a fake repo legend and a stub panel on 127.0.0.1:0 — the real
// panel is never called. exit 0 = all green.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitRoot } from '../../watchdog/scripts/lib/where.mjs';
import { watchersDir } from '../../watchdog/scripts/lib/keepalive.mjs';
import { configRoot } from '../../watchdog/scripts/lib/core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(here, 'watch-groups.mjs');
const CTRL = path.join(here, 'group-control.mjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-watchdog-selftest-'));
const cfg = path.join(out, 'cfg');
const ad = path.join(cfg, 'agentdeck');
const copy0 = path.join(out, 'copy0');
const repo = path.join(out, 'repo');
// A throwaway value made per run: the redaction check needs something the stub can echo back.
const FAKE = ['fake', 'bearer', process.pid, Date.now()].join('-');
for (const d of [ad, copy0, path.join(repo, 'apps/web/src/shared/config/i18n/group-watch')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(repo, 'apps/web/src/shared/config/i18n/group-watch/en.ts'), "export const x = {\n  rule: {\n    R18: 'Guards keep refusing — denials: {{denials}} within {{spanMin}} min',\n  },\n};\n");
const credFile = path.join(out, 'cred');
fs.writeFileSync(credFile, `${FAKE}\n`);
const devlog = path.join(ad, 'dev-watch.log');
fs.writeFileSync(devlog, 'старт\n');
// The legend's feed with the copy's history so far: read quietly at setup, counted in the footer.
const lfeed = path.join(ad, 'verify-ledger', 'events.jsonl');
fs.mkdirSync(path.dirname(lfeed), { recursive: true });
const ev = (e) => fs.appendFileSync(lfeed, `${JSON.stringify({ at: Date.now(), repo: copy0, ...e })}\n`);
ev({ check: 'vitest', key: 'k1', kind: 'record', exit: 0, ms: 60000 });
ev({ check: 'vitest', key: 'k1', kind: 'hit', savedMs: 30000 });
const binCurrent = path.join(ad, 'verify-ledger', 'bin', 'current');
fs.mkdirSync(path.dirname(binCurrent), { recursive: true });
fs.writeFileSync(binCurrent, 'aaa111aaa111\n');
// The limit window feed exists but holds no run yet: COVER ✓, nothing to report.
const limitRuns = path.join(ad, 'limit-runs.json');
fs.writeFileSync(limitRuns, '[]');

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
// The selftest's own session never registers as a watcher (keepalive): its id is stripped unless a case sets one.
// A kit copy keeps its keepalive registry and review counter in the kit state dir: a temp one, never the real.
process.env.AGENTDECK_KIT_STATE = path.join(out, 'kit-state');
const baseEnv = { ...process.env };
delete baseEnv.CLAUDE_CODE_SESSION_ID;
// The real panel's address never leaks in: every case names the stub or a data dir (lib/panel.mjs reads these).
delete baseEnv.AGENTDECK_URL;
delete baseEnv.PORT;
const run = (script, args, env = {}) =>
  new Promise((done) => {
    const ch = spawn(process.execPath, [script, ...args], { env: { ...baseEnv, ...env } });
    let o = '';
    ch.stdout.on('data', (d) => (o += d));
    ch.stderr.on('data', (d) => (o += d));
    ch.on('close', (code) => done({ out: o, code }));
  });
const tagLines = (o, tag) => o.split('\n').filter((l) => new RegExp(`^\\d\\d:\\d\\d:\\d\\d \\S+ ${tag} `).test(l));

// Stub panel: records every request; resume echoes the auth header back so redaction is tested on a real body.
// GET /api/location (lib/panel.mjs discovery) answers the fake data dir and is kept apart: `seen` counts actions.
const seen = [];
const located = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/api/location') {
      located.push({ auth: req.headers.authorization ?? '' });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ paths: { appData: ad } }));
    }
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/pause')) res.end(JSON.stringify({ index: 0, stopped: 1, unconfirmed: 0 }));
    else res.end(JSON.stringify({ index: 0, outcome: 'sent', echo: req.headers.authorization }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ctl = ['--base', base, '--token-file', credFile];

// Fake panel state.
const P = 'p1aaaaaa-0000-1111-2222-333333333333';
// A CLI with no transcript mapping (lib/foreign.mjs MAPPED): status + signals only. Mapped CLIs → selftest-foreign.mjs.
const F = 'aider:abc12345';
const g0 = { index: 0, title: 'G0', status: 'started', path: copy0, chatId: 'c0', stageTrace: [{ stage: 'work' }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
const g2 = { index: 2, title: 'G2', status: 'started', path: path.join(out, 'copy2'), chatId: 'aider:x', stageTrace: [{ stage: 'work' }] };
const state = { splitPlans: { [P]: { parentChatId: P, groups: [g0] }, [F]: { parentChatId: F, groups: [g2] } }, groupWatchSignals: {} };
const saveState = () => fs.writeFileSync(path.join(ad, 'state.json'), JSON.stringify(state));
saveState();
const tdir = path.join(cfg, 'projects', path.resolve(copy0).replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(tdir, { recursive: true });
const tf = path.join(tdir, 'c0aaaaaa-1111-2222-3333-444444444444.jsonl');
let n = 0;
const rec = (r) => fs.appendFileSync(tf, `${JSON.stringify({ sessionId: 'c0', cwd: copy0, timestamp: new Date().toISOString(), ...r })}\n`);
rec({ type: 'user', message: { role: 'user', content: 'Group brief' } });
rec({ type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm test' } }], usage: { input_tokens: 5, cache_read_input_tokens: 1000 } } });

const S = path.join(out, 'state');
const common = ['--state', S, '--app-data', ad, '--config-root', cfg, '--repo', repo];

// 1. group-control against the stub.
let r = await run(CTRL, ['pause', '--group', `${P}:0`, ...ctl]);
const p1 = seen.at(-1);
check('pause posts to /pause with index', p1?.method === 'POST' && p1.url === `/api/chat/split/${P}/pause` && p1.body === '{"index":0}', JSON.stringify(p1));
check('pause sends the Bearer credential', p1?.auth === `Bearer ${FAKE}`);
check('pause prints status + body', r.code === 0 && /^HTTP 200 \{"index":0,"stopped":1/.test(r.out), r.out);
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--force', '--repo', repo, ...ctl]);
const p2 = seen.at(-1);
check('resume posts to /resume-paused with force', p2?.url === `/api/chat/split/${P}/resume-paused` && p2.body === '{"index":0,"force":true}', JSON.stringify(p2));
check('the credential never reaches the output', !r.out.includes(FAKE) && r.out.includes('***'), r.out);
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--note', 'guard fixed', '--first', 'read the job log', '--repo', repo, ...ctl]);
check('resume --note/--first reach the body as one note (N2)', r.code === 0 && seen.at(-1)?.body === '{"index":0,"force":false,"note":"guard fixed Do first: read the job log"}', seen.at(-1)?.body);
r = await run(CTRL, ['restart', '--group', `${P}:0`, ...ctl]);
check('human-only actions are refused', r.code === 2 && seen.length === 3, `code ${r.code}, requests ${seen.length}`);
r = await run(CTRL, ['status', '--group', `${P.slice(0, 8)}:0`, '--app-data', ad]);
check('status reads state.json by parent prefix', r.code === 0 && /started · stage work/.test(r.out), r.out);
// F1 (g1 26.10): resume runs the panel's delivery check first — a fake tests-cli in its own panel repo dir.
{
  const panelFake = path.join(out, 'panel-fake');
  const argvLog = path.join(out, 'fake-delivery.json');
  fs.mkdirSync(path.join(panelFake, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(panelFake, 'tools', 'tests-cli.mjs'),
    "import fs from 'node:fs';\n" +
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: process.argv.slice(2), cfg: process.env.CLAUDE_CONFIG_DIR }));\n` +
      "if (process.env.FAKE_DELIVERY === 'gaps') { console.log('- task point task-1670 is pass with no source'); console.log('- task point task-1669: «qa-gl244» is a label'); process.exitCode = 1; }\n" +
      "else console.log('Delivery: nothing left before the answer.');\n",
  );
  const pre = ['--panel-repo', panelFake, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
  const claim = ['--note', 'pipeline green', '--first', 'Confirm the MR pipeline is green once and finish; nothing to edit'];
  const kF = seen.length;
  r = await run(CTRL, ['resume', '--group', `${P}:0`, ...claim, ...pre], { FAKE_DELIVERY: 'gaps' });
  check('F1: gaps + a «nothing to edit» note — refused with the gaps, no request', r.code === 1 && /^REFUSED the note says no work is left/m.test(r.out) && r.out.includes('task-1670 is pass with no source') && seen.length === kF, r.out);
  const called = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  check('F1: the check is `tests-cli delivery --project <copy>` under the config root', called.argv.join(' ') === `delivery --project ${copy0}` && called.cfg === cfg, JSON.stringify(called));
  r = await run(CTRL, ['resume', '--group', `${P}:0`, '--note', 'guard fixed', ...pre], { FAKE_DELIVERY: 'gaps' });
  const body = JSON.parse(seen.at(-1)?.body ?? '{}');
  check('F1: gaps + a plain note — the gaps ride in the note, one request', r.code === 0 && seen.length === kF + 1 && body.note?.startsWith('guard fixed The panel') && body.note.includes('task-1669') && /2 gap\(s\) added/.test(r.out), `${r.out} ${seen.at(-1)?.body}`);
  r = await run(CTRL, ['resume', '--group', `${P}:0`, ...claim, ...pre], { FAKE_DELIVERY: 'clean' });
  check('F1: exit 0 — the «nothing to edit» note goes as written', r.code === 0 && seen.length === kF + 2 && JSON.parse(seen.at(-1).body).note === 'pipeline green Do first: Confirm the MR pipeline is green once and finish; nothing to edit' && /exit 0, nothing left/.test(r.out), r.out);
  r = await run(CTRL, ['resume', '--group', `${P}:0`, ...claim, ...ctl, '--repo', repo, '--app-data', ad, '--config-root', cfg]);
  check('F1: no tests-cli to run — a «nothing to edit» note is refused, no request', r.code === 1 && /could not run/.test(r.out) && seen.length === kF + 2, r.out);
}
// M-12: a group resumed mid-fix. The refusal happens before any request reaches the panel.
const holdFile = path.join(repo, '.agent', 'live-watch', 'hold.json');
const inboxFile = path.join(repo, '.agent', 'live-watch', 'inbox.agent.md');
r = await run(CTRL, ['hold', '--reason', 'paused until the owner says go', '--repo', repo]);
check('hold writes hold.json', r.code === 0 && fs.existsSync(holdFile), r.out);
const k0 = seen.length;
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--repo', repo, ...ctl]);
check('resume under a hold is refused with no request', r.code === 1 && /^REFUSED HOLD since .*paused until the owner says go/.test(r.out) && seen.length === k0, r.out);
r = await run(CTRL, ['release', '--owner', 'запускай', '--repo', repo]);
check('release removes the hold', r.code === 0 && !fs.existsSync(holdFile) && /released by the owner: запускай/.test(r.out), r.out);
fs.writeFileSync(inboxFile, '# inbox\n- I-1 · now · fixed · done\n- I-2 · now · fixing · half-done\n- I-3 · earlier · open · new\n');
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--repo', repo, ...ctl]);
check('resume with open/fixing inbox rows is refused, naming them', r.code === 1 && /open inbox rows I-2, I-3/.test(r.out) && seen.length === k0, r.out);
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--repo', repo, '--allow-open', 'I-2', ...ctl]);
check('--allow-open naming only some rows still refuses', r.code === 1 && /open inbox rows I-3 /.test(r.out) && seen.length === k0, r.out);
r = await run(CTRL, ['resume', '--group', `${P}:0`, '--repo', repo, '--allow-open', 'I-2,I-3', ...ctl]);
check('--allow-open naming every open row lets resume through', r.code === 0 && seen.length === k0 + 1 && seen.at(-1).url.endsWith('/resume-paused'), r.out);
r = await run(CTRL, ['continue', '--group', `${P}:0`, '--repo', repo, ...ctl]);
check('continue with open inbox rows is refused like resume', r.code === 1 && /open inbox rows I-2, I-3/.test(r.out) && seen.length === k0 + 1, r.out);
fs.rmSync(inboxFile);
r = await run(CTRL, ['continue', '--group', `${P}:0`, '--repo', repo, ...ctl]);
check('continue posts to /continue-group with index (agent action since 25.10)', r.code === 0 && seen.at(-1)?.url === `/api/chat/split/${P}/continue-group` && seen.at(-1)?.body === '{"index":0}', JSON.stringify(seen.at(-1)));

// 2. watch-groups: setup, then every state.json diff.
r = await run(WATCH, [...common, '--group', `${P}:0`, '--group', `${F}:2`]);
check('setup exits 0', r.code === 0, r.out.slice(0, 300));
check('a watched group is never named NEXT', !tagLines(r.out, 'NEXT').length, tagLines(r.out, 'NEXT').join(' | '));
check('claude group footer carries group status', /^\[g0-p1aaaa\] .*started · stage work · nudges 0/m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('[')).join(' | '));
check('foreign group is status-only', /^\[g2-aidera\] .*FOREIGN aider — status \+ signals only/m.test(r.out));
check('busy while a call is open', /^\[g0-p1aaaa\] busy\(open Bash/m.test(r.out));
check('footer carries the token spend of the messages read', /^\[g0-p1aaaa\] .* spent 1 msg out \S+ write \S+ read \S+/m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('[g0')).join(''));
check('footer carries the legend history of the copy', /^\[g0-p1aaaa\] .*legend rec 1 \(\S+\) hit 1 \(\S+ saved, 50%\)/m.test(r.out));
check('COVER names every source as read', /^COVER state ✓ .*rule texts ✓ 1 · legend ✓ 1\/2 copies · restarts ✓ 0\/h · window ✓ no samples yet · D-n ✓ none yet · transcripts 1\/1 \(\+1 status-only\) · spend 1\/1$/m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('COVER')).join(''));

Object.assign(g0, { status: 'awaiting', waitingFor: 'decision', deliveryNudges: 1, deliveryMissing: ['sieve X failed: run it'], deliveryHistory: [{ at: 1 }], mr: 'https://git.example.com/x/-/merge_requests/5', stageTrace: [{ stage: 'work' }, { stage: 'deliver' }], chatId: 'c0b' });
state.groupWatchSignals[P] = { 0: { signals: [{ id: 's1', rule: 'R18', severity: 'warn', stage: 'deliver', numbers: { denials: 6, spanMin: 5 } }] } };
g2.status = 'failed';
saveState();
fs.writeFileSync(path.join(ad, 'dev-restart.json'), JSON.stringify({ since: '2026-10-24T10:00:00Z', files: ['a.ts'], waitingFor: 'runs', runs: [copy0] }));
fs.appendFileSync(path.join(ad, 'dev-watch.log'), 'перезапуск: 1 файл сервера изменён\n');
r = await run(WATCH, [...common, '--once']);
const o = r.out;
check('STATUS names the transition', tagLines(o, 'STATUS').some((l) => /started → awaiting\(decision\)/.test(l)), tagLines(o, 'STATUS').join(' | '));
// Severity decides how fast the watch wakes: hi = STATUS(human wait) MR WSIG(warn) ENDED RESTART(our copy) STAGE
// (its audit is spawned now).
check('severities: 6 hi, 5 mid', /hi 6 mid 5/.test(o.split('\n')[0]), o.split('\n')[0]);
for (const t of ['STAGE', 'NUDGE', 'ROUND', 'MISSING', 'MR', 'CONV', 'WSIG', 'ENDED', 'RESTART']) check(`group flag ${t} fires`, tagLines(o, t).length > 0);
check('WSIG carries the rule text with numbers', tagLines(o, 'WSIG').some((l) => /R18 warn deliver: Guards keep refusing — denials: 6 within 5 min/.test(l)), tagLines(o, 'WSIG').join(' | '));
check('pending restart naming a watched copy is flagged as such', tagLines(o, 'RESTART').some((l) => /includes a watched copy/.test(l)));
check('dev-watch log restart line is relayed with its cause', tagLines(o, 'RESTART').some((l) => /перезапуск: 1 файл.* — edited by no watched group/.test(l)), tagLines(o, 'RESTART').join(' | '));
fs.writeFileSync(path.join(ad, 'dev-restart.json'), JSON.stringify({ since: '2026-10-24T10:00:00Z', files: ['a.ts'], waitingFor: 'runs', runs: [copy0] }));
r = await run(WATCH, [...common, '--once']);
check('a rewritten restart file with the same content is silent', tagLines(r.out, 'RESTART').length === 0, tagLines(r.out, 'RESTART').join(' | '));
fs.writeFileSync(path.join(ad, 'dev-restart.json'), JSON.stringify({ since: '2026-10-24T10:00:00Z', files: ['a.ts', 'b.ts', 'c.ts'], waitingFor: 'runs', runs: [copy0] }));
r = await run(WATCH, [...common, '--once']);
check('the same pending restart grown by files no watched group edited is silent', tagLines(r.out, 'RESTART').length === 0, tagLines(r.out, 'RESTART').join(' | '));
// 26.10 #—:41–43: the reason flipped (runs ↔ checks) and an unwatched run joined, over the same watched copy.
fs.writeFileSync(path.join(ad, 'dev-restart.json'), JSON.stringify({ since: '2026-10-24T10:00:00Z', files: ['a.ts', 'b.ts', 'c.ts'], waitingFor: 'checks', runs: [copy0, 'C:/elsewhere/other-copy'] }));
r = await run(WATCH, [...common, '--once']);
check('the same pending restart waiting for another reason or an unwatched run is silent', tagLines(r.out, 'RESTART').length === 0, tagLines(r.out, 'RESTART').join(' | '));
fs.writeFileSync(path.join(ad, 'dev-restart.json'), JSON.stringify({ since: '2026-10-24T10:00:00Z', files: ['a.ts', 'b.ts', 'c.ts'], waitingFor: 'runs', runs: ['C:/elsewhere/other-copy'] }));
r = await run(WATCH, [...common, '--once']);
check('a watched copy leaving the wait re-raises the pending restart', tagLines(r.out, 'RESTART').some((l) => /pending since/.test(l) && !/includes a watched copy/.test(l)), tagLines(r.out, 'RESTART').join(' | '));

// 2b. The legend (verify-ledger feed), the restart rate and a blind source.
ev({ check: 'vitest', key: 'k1', kind: 'miss', reason: 'no-record' });
ev({ check: 'vitest', key: 'k1', kind: 'record', exit: 0, ms: 4000 });
ev({ check: 'tsc', key: 'k2', kind: 'off', reason: 'snapshot-failed: git add' });
ev({ check: 'vitest', key: 'k3', kind: 'off', reason: 'tree-changed' });
ev({ check: 'vitest', key: 'k4', kind: 'mismatch', recordedExit: 0, exit: 1 });
ev({ check: 'eslint', key: 'k5', kind: 'record', exit: 0, ms: 1000 });
ev({ check: 'eslint', key: 'k5', kind: 'miss', reason: 'stale' });
ev({ check: 'eslint', key: 'k5', kind: 'record', exit: 0, ms: 1000 });
ev({ check: 'tsc', key: 'k6', kind: 'record', exit: 2, ms: 1000 });
ev({ repo: path.join(out, 'elsewhere'), check: 'tsc', key: 'kx', kind: 'record', exit: 0, ms: 1 });
const iso = new Date().toISOString();
fs.appendFileSync(devlog, Array.from({ length: 6 }, (_, i) => `${iso} перезапуск: f${i}.ts\n`).join(''));
// Not restarts (25.10): a deferral and a restart dev-watch skipped — the counts below stay 7 and 6.
fs.appendFileSync(devlog, `${iso} правки ждут конца идущих ходов, подготовки копий и проверок — перезапуск без предела отложен\n${iso} файлы проверки поломкой вернулись к оригиналу — перезапуск не нужен\n`);
fs.writeFileSync(binCurrent, 'bbb222bbb222\n');
r = await run(WATCH, [...common, '--once']);
const led = tagLines(r.out, 'LEDGER');
const ledHas = (re) => led.some((l) => re.test(l));
check('LEDGER: a reinstalled legend version is named between wakes', ledHas(/legend reinstalled aaa111aaa111 → bbb222bbb222/), led.join(' | '));
check('LEDGER: a green re-run on a key the legend holds is a missed replay', ledHas(/vitest re-ran on a tree the legend holds green \(key k1\) — replay missed/), led.join(' | '));
check('LEDGER: a legend switched off for the copy is named', ledHas(/legend off for this copy: snapshot-failed: git add \(tsc\)/));
check('LEDGER: a run not recorded because the tree moved', ledHas(/vitest not recorded: the tree changed while it ran/));
check('LEDGER: a replay that would differ', ledHas(/vitest replay would differ: recorded exit 0, real exit 1/));
check('LEDGER: a replay refused for its own reason', ledHas(/eslint replay refused: stale/));
check('LEDGER: real runs with no replay in one call', ledHas(/3 checks ran for real this call, 0 replays/));
check('LEDGER: a refused-then-rerun key is not a missed replay', !ledHas(/eslint re-ran/));
check('LEDGER: another repo is never counted', !ledHas(/kx/) && /legend rec 5 \(\S+\) hit 1 \(\S+ saved, 17%\) Δ 0 · /m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('[g0')).join(''));
check('STORM: restarts per hour over the limit', tagLines(r.out, 'STORM').some((l) => /7 server restarts in the last hour/.test(l)), tagLines(r.out, 'STORM').join(' | '));
check('RESTART: plain restarts collapse into one line', tagLines(r.out, 'RESTART').length === 1 && tagLines(r.out, 'RESTART').some((l) => /6 restart\(s\), last: .*f5\.ts/.test(l)), tagLines(r.out, 'RESTART').join(' | '));
fs.rmSync(lfeed);
r = await run(WATCH, [...common, '--once']);
check('COVER: a missing legend feed is blind, flagged once', tagLines(r.out, 'COVER').some((l) => /blind: legend ✗ no verify-ledger\/events\.jsonl/.test(l)) && /^COVER .*legend ✗/m.test(r.out), r.out.split('\n').filter((l) => /COVER/.test(l)).join(' | '));
r = await run(WATCH, [...common, '--once']);
check('COVER: the same blind spot is not re-flagged', tagLines(r.out, 'COVER').length === 0 && tagLines(r.out, 'STORM').length === 0);
check('LEDGER: an unchanged legend version stays silent', !tagLines(r.out, 'LEDGER').some((l) => /reinstalled/.test(l)), tagLines(r.out, 'LEDGER').join(' | '));
// #g3:123 (25.10): first runs on trees the legend never saw have nothing to replay — no LEDGER waste.
for (const key of ['f1', 'f2', 'f3']) {
  ev({ check: 'tsc', key, kind: 'miss', reason: 'no-record' });
  ev({ check: 'tsc', key, kind: 'record', exit: 0, ms: 500 });
}
r = await run(WATCH, [...common, '--once']);
check('LEDGER: first runs on new trees are not a missed replay', !tagLines(r.out, 'LEDGER').some((l) => /ran for real/.test(l)), tagLines(r.out, 'LEDGER').join(' | '));

// 3. pause-at-safe: never while busy, once at the safe point. A wait the panel itself ends (the delivery check) —
// a human wait is never paused (selftest-stage-audit J).
g0.waitingFor = 'delivery';
saveState();
const before = seen.length;
r = await run(WATCH, [...common, '--once', '--pause-at-safe', `${P}:0`, ...ctl]);
check('a busy group is not paused', seen.length === before && tagLines(r.out, 'PAUSED').length === 0, `requests ${seen.length - before}`);
rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } });
rec({ type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Stage done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1200 } } });
r = await run(WATCH, [...common, '--once', '--pause-at-safe', `${P}:0`, ...ctl]);
check('pause fires once at the safe point', seen.length === before + 1 && seen.at(-1).url.endsWith('/pause') && tagLines(r.out, 'PAUSED').length === 1, `requests ${seen.length - before}: ${tagLines(r.out, 'PAUSED').join('')}`);
check('the pause line never prints the credential', !r.out.includes(FAKE));
r = await run(WATCH, [...common, '--once', '--pause-at-safe', `${P}:0`, ...ctl]);
check('no second pause for the same stage', seen.length === before + 1, `requests ${seen.length - before}`);

// 4. The state never goes into a watched copy.
r = await run(WATCH, ['--state', path.join(copy0, '.agent', 'w'), '--app-data', ad, '--config-root', cfg, '--group', `${P}:0`, '--once']);
check('state inside the group copy is refused', r.code === 2 && !fs.existsSync(path.join(copy0, '.agent')), `code ${r.code}`);
const copy2 = g2.path;
r = await run(WATCH, ['--state', path.join(copy2, '.agent', 'w'), '--app-data', ad, '--config-root', cfg, '--group', `${F}:2`, '--once']);
check('state inside a foreign group copy is refused', r.code === 2 && !fs.existsSync(copy2), `code ${r.code}`);

// 5. The library refuses human-only actions too (watch-groups imports it, not only the CLI).
const { control } = await import('./group-control.mjs');
const k = seen.length;
const lib = await control({ action: 'relaunch', parent: P, index: 0, base, tokenFile: credFile });
check('control() sends nothing for a human-only action', seen.length === k && /human-only/.test(lib.body), lib.body);

// 6. Waste arms a pause, burn pauses now, the legend's GAP, the stage audit, restart attribution (state S2, group 3).
const copy3 = path.join(out, 'copy3');
fs.mkdirSync(copy3, { recursive: true });
const g3 = { index: 3, title: 'G3', status: 'started', path: copy3, chatId: 'c3', stageTrace: [{ stage: 'work', at: new Date(Date.now() - 600e3).toISOString() }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null };
state.splitPlans[P].groups.push(g3);
saveState();
const tdir3 = path.join(cfg, 'projects', path.resolve(copy3).replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(tdir3, { recursive: true });
const tf3 = path.join(tdir3, 'c3aaaaaa-1111-2222-3333-444444444444.jsonl');
let clock3 = Date.now() - 300e3;
const at3 = () => new Date((clock3 += 2000)).toISOString();
const rec3 = (r) => fs.appendFileSync(tf3, `${JSON.stringify({ sessionId: 'c3', cwd: copy3, timestamp: at3(), ...r })}\n`);
const say3 = (content, stop = 'tool_use') => rec3({ type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: stop, content, usage: { input_tokens: 5, cache_read_input_tokens: 2000 } } });
const bash3 = (id, command, result = 'ok') => {
  say3([{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
  const startAt = clock3;
  rec3({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
  return { startAt, endAt: clock3 };
};
rec3({ type: 'user', message: { role: 'user', content: 'Group 3 brief' } });
// The legend already ran (another repo's event before x1): x1 had a ledger to reach.
ev({ repo: path.join(out, 'elsewhere'), check: 'vitest', key: 'k8', kind: 'record', exit: 0, ms: 1, at: clock3 - 1000 });
bash3('x1', 'pnpm test');
// A minute apart: x2's ledger event must fall outside x1's window [start-3s, end+10s]. The edit between them makes
// x2 a legitimate run (no RERUN), so GAP alone is the waste that arms the pause.
clock3 += 60e3;
say3([{ type: 'tool_use', id: 'e0', name: 'Edit', input: { file_path: path.join(copy3, 'a.ts'), old_string: 'a', new_string: 'b' } }]);
rec3({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e0', content: 'ok' }] } });
const x2 = bash3('x2', 'pnpm test');
// x2 went through the legend (a replay while it ran); x1 left no ledger event at all.
ev({ repo: copy3, check: 'vitest', key: 'k9', kind: 'hit', savedMs: 1000, at: x2.startAt + 500 });
// #g8:88 (26.10): x3 ran in a review clone outside the copy (shell 8.3 path, ledger long path) — the legend saw it there.
clock3 += 60e3;
const x3 = bash3('x3', 'C="C:/USERS/SHORT~1/Temp/claude-review/review-s/clone/docs-ui"; cd "$C" && npm run type-check');
ev({ repo: path.join(out, 'Temp', 'claude-review', 'review-s', 'clone'), check: 'tsc', key: 'k10', kind: 'record', exit: 0, ms: 1, at: x3.startAt + 500 });
const S2 = path.join(out, 'state2');
const c2 = ['--state', S2, '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
const k6 = seen.length;
r = await run(WATCH, [...c2, '--group', `${P}:3`, '--from', 'start', '--once']);
const foot3 = (o2) => o2.split('\n').find((l) => l.startsWith('[g3]')) ?? '';
check('GAP: a check with no ledger event from its copy is outside the legend', tagLines(r.out, 'GAP').length === 1 && /pnpm test ran .* no verify-ledger event from this copy/.test(tagLines(r.out, 'GAP')[0] ?? ''), tagLines(r.out, 'GAP').join(' | '));
check('a check after an edit is no RERUN', tagLines(r.out, 'RERUN').length === 0, tagLines(r.out, 'RERUN').join(' | '));
check('GAP: a check the ledger saw in a clone its command names is no GAP', !tagLines(r.out, 'GAP').some((l) => /type-check/.test(l)), tagLines(r.out, 'GAP').join(' | '));
{
  // A check that ended before the feed's earliest event ran before the legend existed (25.10: g0's 23.10 checks, feed from 24.10).
  const feed = fs.readFileSync(lfeed, 'utf8');
  fs.writeFileSync(lfeed, `${feed.split('\n').filter((l) => l && !l.includes('"k8"')).join('\n')}\n`);
  const pre = await run(WATCH, ['--state', path.join(out, 'state2b'), '--app-data', ad, '--config-root', cfg, '--repo', repo, '--group', `${P}:3`, '--from', 'start', '--once']);
  check('GAP: a check that ended before the legend feed began is no GAP', !tagLines(pre.out, 'GAP').length, tagLines(pre.out, 'GAP').join(' | '));
  fs.writeFileSync(lfeed, feed);
}
check('GAP is waste: it arms the group pause at its safe point', /ARMED pause at safe point \(GAP gap #g3:\d+\)/.test(foot3(r.out)), foot3(r.out));
check('an armed group mid-turn is not paused', seen.length === k6 && tagLines(r.out, 'PAUSED').length === 0, `requests ${seen.length - k6}`);
say3([{ type: 'text', text: 'Готово.' }], 'end_turn');
r = await run(WATCH, [...c2, '--once']);
check('the armed pause fires at the safe point, naming its flag', seen.length === k6 + 1 && tagLines(r.out, 'PAUSED').some((l) => /at safe point .* for GAP gap #g3:\d+: HTTP 200/.test(l)) && !/ARMED/.test(foot3(r.out)), `${seen.length - k6}: ${tagLines(r.out, 'PAUSED').join(' | ')}`);
g3.status = 'paused';
saveState();
await new Promise((res) => setTimeout(res, 4100));
r = await run(WATCH, [...c2, '--once']);
g3.status = 'started';
saveState();
await new Promise((res) => setTimeout(res, 4100));
rec3({ type: 'user', message: { role: 'user', content: 'go on' } });
// 26.10 #g9:116: seen paused inside the grace, then resumed; the first look past the grace saw it writing.
{
  const f = path.join(S2, 'watch-state.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.plugin.race.g3.at = Date.now() - 60e3;
  fs.writeFileSync(f, JSON.stringify(st));
}
r = await run(WATCH, [...c2, '--once']);
check('PAUSE-RACE: none once the group was seen paused and then resumed', !tagLines(r.out, 'PAUSE-RACE').length, tagLines(r.out, 'PAUSE-RACE').join(' | '));
bash3('x4', 'pnpm test');
// The loop runs now: the watch reads the rerun while it is still open (a burn whose call already returned minutes
// before the watch saw it waits for the safe point — selftest-stage-audit H).
say3([{ type: 'tool_use', id: 'x5', name: 'Bash', input: { command: 'pnpm test' } }]);
r = await run(WATCH, [...c2, '--once']);
check('BURN (rerun twice in one turn) after a resume pauses NOW, mid-turn', seen.length === k6 + 2 && tagLines(r.out, 'BURN').length === 1 && tagLines(r.out, 'PAUSED').some((l) => /NOW, mid-turn for BURN rerun/.test(l)), `${seen.length - k6}: ${tagLines(r.out, 'PAUSED').join(' | ')} ${tagLines(r.out, 'BURN').join(' | ')}`);
rec3({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x5', content: 'ok' }] } });
// The stub panel never moves the group to paused: past the grace the pause did not hold.
const st2f = path.join(S2, 'watch-state.json');
const st2 = JSON.parse(fs.readFileSync(st2f, 'utf8'));
st2.plugin.race.g3.at = Date.now() - 60e3;
fs.writeFileSync(st2f, JSON.stringify(st2));
r = await run(WATCH, [...c2, '--once']);
check('PAUSE-RACE: a 2xx pause the panel never reflected', tagLines(r.out, 'PAUSE-RACE').some((l) => /the panel still shows started/.test(l)), tagLines(r.out, 'PAUSE-RACE').join(' | '));
bash3('x6', 'pnpm test');
r = await run(WATCH, [...c2, '--once']);
check('a new waste re-arms, but no second pause in the same chat and stage', /ARMED/.test(foot3(r.out)) && seen.length === k6 + 2, `${seen.length - k6} ${foot3(r.out)}`);
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`]);
check('--disarm without --row is refused', r.code === 2 && /needs --row/.test(r.out), r.out.slice(0, 200));
const ledgerMd = path.join(repo, '.agent', 'live-watch', '2026-10-25-g3.agent.md');
fs.writeFileSync(ledgerMd, '| L-9 | 03:00 | S2 | rerun-same-tree | skill | #g3:5 | no edit | — | — | — | open |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm with a row that is not fixed is refused', r.code === 2 && /not fixed/.test(r.out), r.out.slice(0, 200));
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-404']);
check('--disarm naming a row no ledger holds is refused', r.code === 2 && /no row L-404 in /.test(r.out), r.out.slice(0, 200));
fs.writeFileSync(ledgerMd, '| L-9 | 03:00 | S2 | rerun-same-tree | skill | #g3:5 | fixed elsewhere? expected later | — | — | — | open |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm reads the status cell: «fixed»/«expected» in another cell of an open row is refused', r.code === 2 && /not fixed/.test(r.out), r.out.slice(0, 200));
const otherMd = path.join(repo, '.agent', 'live-watch', '2026-10-25-g0.agent.md');
fs.writeFileSync(otherMd, '| 7 | 03:00 | S3 | x | — | see row L-9 | — | — | — | — | fixed |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm finds a row by its id cell, not by «row L-9» in another ledger', r.code === 2 && /not fixed/.test(r.out), r.out.slice(0, 200));
fs.writeFileSync(otherMd, '| L-9 | 03:00 | S3 | x | — | — | — | — | — | — | fixed |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm refuses an id two ledgers share and names the file form', r.code === 2 && /is in .*g0\.agent\.md.*<file part>:L-9/.test(r.out), r.out.slice(0, 200));
fs.rmSync(otherMd);
// The fixed row already moved to the doc-hygiene archive (terminal rows leave an over-budget ledger).
fs.writeFileSync(ledgerMd, '');
const archMd = path.join(repo, '.agent', 'archive', 'live-watch', '2026-10-25-g3.agent.md');
fs.mkdirSync(path.dirname(archMd), { recursive: true });
fs.writeFileSync(archMd, '| L-9 | 03:00 | S2 | rerun-same-tree | skill | #g3:5 | no edit | watch rule | — | selftest → green | fixed |\n');
// 26.10: repeated pairs all took the LAST --row — an open row's pair went through on a later pair's fixed row.
fs.writeFileSync(ledgerMd, '| L-8 | 03:00 | S2 | x | — | #g3:4 | — | — | — | — | open |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-8', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm pairs: each --disarm owns the --row after it (open L-8 refused though L-9 is fixed)', r.code === 2 && /row L-8 is not fixed/.test(r.out), r.out.slice(0, 200));
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--disarm', `${P}:3`, '--row', 'L-8', '--row', 'L-9', '--row', 'L-9']);
check('--disarm pairs: a --row count that is neither 1 nor one per --disarm is refused', r.code === 2 && /2 --disarm but 3 --row/.test(r.out), r.out.slice(0, 200));
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm with a fixed row (archived under .agent/archive/live-watch) removes the arm and says so', r.code === 0 && !/ARMED/.test(foot3(r.out)) && /disarmed g3 by row L-9/.test(r.out), `${r.code} ${foot3(r.out)}`);
fs.rmSync(archMd);
// A restart caused by the group's own edit: attributed to it, hi, and it arms the group.
const served = path.join(repo, 'apps', 'server', 'src', 'x.ts');
say3([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: served, old_string: 'a', new_string: 'b' } }]);
rec3({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } });
r = await run(WATCH, [...c2, '--once']);
fs.appendFileSync(devlog, `${new Date().toISOString()} перезапуск: ${served}\n`);
r = await run(WATCH, [...c2, '--once']);
check('RESTART by a group edit is attributed to it, hi, and arms it', tagLines(r.out, 'RESTART').some((l) => /^\S+ g3 RESTART 1 restart\(s\), .*x\.ts — edited by g3/.test(l)) && /ARMED pause at safe point \(RESTART restart/.test(foot3(r.out)), `${tagLines(r.out, 'RESTART').join(' | ')} ${foot3(r.out)}`);
fs.writeFileSync(ledgerMd, '| L-9 | 03:00 | — | own-restart | — | RESTART #g3:5 | edit the task needs | none needed | — | — | expected |\n');
r = await run(WATCH, [...c2, '--once', '--disarm', `${P}:3`, '--row', 'L-9']);
check('--disarm with an expected row (flag judged no waste) removes the arm', r.code === 0 && !/ARMED/.test(foot3(r.out)) && /disarmed g3 by row L-9/.test(r.out), `${r.code} ${foot3(r.out)}`);
// Rework and the stage audit.
Object.assign(g3, { deliveryNudges: 2, deliveryHistory: [{ at: 1 }, { at: 2 }], stageTrace: [...g3.stageTrace, { stage: 'deliver', at: new Date().toISOString() }] });
saveState();
await new Promise((res) => setTimeout(res, 4100));
r = await run(WATCH, [...c2, '--once']);
check('NUDGE #2 is hi rework', tagLines(r.out, 'NUDGE').some((l) => /delivery nudge #2 .*rework/.test(l)) && /hi \d+/.test(r.out), tagLines(r.out, 'NUDGE').join(' | '));
check('ROUND 2 fires', tagLines(r.out, 'ROUND').some((l) => /delivery round 2/.test(l)));
const stage3 = tagLines(r.out, 'STAGE').join(' | ');
check('STAGE names how long the stage took and the audit to spawn', /work → deliver · work took ≥\S+ \(began before the watch\), \S+ tok watched · audit: spawn «review: watch audit g3 work» \(lane-high\) on node \S+show\.mjs --state \S+ --pack g3 --from setup --to stage:deliver/.test(stage3), stage3);
const SHOWJS = path.join(here, '..', '..', 'watchdog', 'scripts', 'show.mjs');
r = await run(SHOWJS, ['--state', S2, '--marks', 'g3']);
check('the stage left a mark', /setup/.test(r.out) && /stage:deliver/.test(r.out), r.out);
r = await run(SHOWJS, ['--state', S2, '--pack', 'g3', '--from', 'setup', '--to', 'stage:deliver']);
check('show --pack reads the stage, one line per record', /^== pack g3 from setup/m.test(r.out) && /CALL Bash \{"command":"pnpm test"\}/.test(r.out) && /USER go on/.test(r.out), r.out.slice(0, 400));
r = await run(SHOWJS, ['--state', S2, '--pack', 'g3', '--from', 'stage:never', '--to', 'stage:deliver']);
check('show --pack from an unrecorded mark refuses (exit 2) and lists the recorded marks, never packs another stretch', r.code === 2 && /^refused: mark not recorded for g3: --from stage:never — recorded: setup \S+, .*stage:deliver/m.test(r.out) && !/CALL Bash/.test(r.out), `${r.code} ${r.out.slice(0, 400)}`);
r = await run(SHOWJS, ['--state', S2, '--pack', 'g3', '--from', 'setup', '--to', 'stage:never']);
check('show --pack to an unrecorded mark refuses (exit 2), never packs to «now»', r.code === 2 && /--to stage:never/.test(r.out) && !/CALL Bash/.test(r.out), `${r.code} ${r.out.slice(0, 400)}`);
// F-15 (25.10): header in local time, record lines in UTC. Two zones 5 h apart: every printed time moves by the same 5 h.
{
  const at = async (tz) => (await run(SHOWJS, ['--state', S2, '--pack', 'g3', '--from', 'setup', '--to', 'stage:deliver'], { TZ: tz })).out;
  const [u, t] = [await at('UTC'), await at('Asia/Tashkent')];
  const sec = (x) => (x ? x.split(':').reduce((a, b) => a * 60 + Number(b), 0) : NaN);
  const head = (o) => sec(o.match(/^== pack g3 from setup (\d\d:\d\d:\d\d)/m)?.[1]);
  const call = (o) => sec(o.match(/^(\d\d:\d\d:\d\d) CALL Bash \{"command":"pnpm test"\}/m)?.[1]);
  const shift = (a, b) => (b - a + 86400) % 86400;
  check('show --pack prints the header and the record lines in one zone, and names it', shift(head(u), head(t)) === 18000 && shift(call(u), call(t)) === 18000 && /times local UTC\+00:00/.test(u) && /times local UTC\+05:00/.test(t), `${u.split('\n').slice(0, 3).join(' | ')} || ${t.split('\n').slice(0, 3).join(' | ')}`);
}
g3.status = 'done';
g3.mr = 'https://git.example.com/x/-/merge_requests/9';
saveState();
await new Promise((res) => setTimeout(res, 4100));
r = await run(WATCH, [...c2, '--once']);
check('ENDED names the audit of the last stage and the whole run', tagLines(r.out, 'ENDED').some((l) => /audit: spawn «review: watch audit g3 deliver» .*--pack g3 --from stage:deliver --to ended, flags: --list g3 --from stage:deliver --to ended --last 400; whole run: --from setup --to ended/.test(l)), tagLines(r.out, 'ENDED').join(' | '));

// 7. A coordinator watch registers its session; every group done releases the keepalive.
const proj = path.join(out, 'proj');
const S3 = path.join(proj, '.agent', 'tmp', 'watchdog', 's3');
const SID = `selftest-${process.pid}`;
const readReg = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(watchersDir(cfg), `${SID}.json`), 'utf8'));
  } catch {
    return null;
  }
};
// g3 is done, but g0 of the same split still runs unwatched: the turn stays held and the next call takes g0 (M-02).
// g9 is queued with no copy yet: it holds the turn too, and joins a call only once its copy exists.
fs.mkdirSync(path.join(proj, '.agent', 'live-watch'), { recursive: true });
const g9 = { index: 9, title: 'G9', status: 'pending', chatId: null, stageTrace: [] };
state.splitPlans[P].groups.push(g9);
saveState();
r = await run(WATCH, ['--state', S3, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--group', `${P}:3`, '--once'], { CLAUDE_CODE_SESSION_ID: SID });
let reg = readReg();
check('an open sibling of the split keeps the keepalive on', reg?.allDone === false && (reg?.live ?? []).includes(`${P}:0`) && /keepalive on/.test(r.out), JSON.stringify(reg)?.slice(0, 300));
check('NEXT names the unwatched sibling, and the next call adds it', tagLines(r.out, 'NEXT').some((l) => l.includes(`group ${P}:0 is ${g0.status} and not watched yet`)) && (reg?.cmd ?? '').endsWith(` --group ${P}:0`), `${tagLines(r.out, 'NEXT').join(' | ')} || ${reg?.cmd}`);
check('a queued sibling with no copy holds the turn, and is not added before its copy exists', (reg?.live ?? []).includes(`${P}:9`) && !tagLines(r.out, 'NEXT').some((l) => l.includes(`${P}:9`)) && !(reg?.cmd ?? '').includes(`--group ${P}:9`), `${tagLines(r.out, 'NEXT').join(' | ')} || ${JSON.stringify(reg)?.slice(0, 300)}`);
check('the next-call command carries the flags the state does not keep', /watch-groups\.mjs --state \S+s3 --app-data \S+ --repo \S+ --config-root \S+/.test(reg?.cmd ?? ''), reg?.cmd);
// The keepalive's own command, run as printed: g0 becomes a watched unit and stops being named. Every flag but NEXT
// gets its row first, so the call runs only if NEXT owes none.
const rows3 = path.join(proj, '.agent', 'live-watch', 'rows.agent.md');
// Refs from flag lines only: the «rows owed» footer repeats them, and would row a skipped tag behind its back.
const rowAll = (o, skip) => fs.appendFileSync(rows3, `${o.split('\n').filter((l) => /^\d\d:\d\d:\d\d \S+ \S+ /.test(l) && !(skip && skip.test(l))).flatMap((l) => l.match(/#[^\s:]+:\d+/g) ?? []).join('\n')}\n`);
rowAll(r.out, /^\S+ \S+ NEXT /);
r = await run(WATCH, [...String(reg?.cmd ?? '').split(' ').slice(2), '--once'], { CLAUDE_CODE_SESSION_ID: SID });
reg = readReg();
check('the printed next call watches the sibling and stops naming it', r.code === 0 && (reg?.live ?? []).includes('g0') && !(reg?.live ?? []).includes(`${P}:0`) && !tagLines(r.out, 'NEXT').length && !(reg?.cmd ?? '').includes(`--group ${P}:0`), `code ${r.code} · live ${reg?.live} · cmd …${String(reg?.cmd).slice(-60)} · ${tagLines(r.out, 'NEXT').join(' | ')}`);
rowAll(r.out);
// g9 closes unwatched: a closed group no unit watches holds nothing.
g9.status = 'failed';
const g0was = g0.status;
g0.status = 'done';
saveState();
await new Promise((res) => setTimeout(res, 4100));
r = await run(WATCH, ['--state', S3, '--app-data', ad, '--config-root', cfg, '--repo', repo, '--once'], { CLAUDE_CODE_SESSION_ID: SID });
reg = readReg();
check('every group of the split closed releases the keepalive', reg?.allDone === true && /keepalive released \(all done\)/.test(r.out) && !(reg?.cmd ?? '').includes('--group'), JSON.stringify(reg)?.slice(0, 300));
g0.status = g0was;
state.splitPlans[P].groups.splice(state.splitPlans[P].groups.indexOf(g9), 1);
saveState();

// 8. The limit window: its level is news on first sight, a heavy run of a watched group is RUN hi.
const now8 = Date.now();
const sample = (at, five, seven) => ({ at, fiveHour: { utilization: five, resetsAt: Math.round(now8 / 1000) + 3600 }, sevenDay: { utilization: seven, resetsAt: Math.round(now8 / 1000) + 86400 } });
fs.writeFileSync(limitRuns, JSON.stringify([{ id: 'r1', chatId: 'c0b', sessionId: 's', startedAt: now8 - 60e3, endedAt: now8 - 30e3, tokens: 1000, samples: [sample(now8 - 30e3, 0.2, 0.91)] }]));
r = await run(WATCH, [...common, '--once']);
check('WINDOW: a window over 90% on first sight is hi', tagLines(r.out, 'WINDOW').some((l) => /7-day window at 91% \(resets in/.test(l)) && !tagLines(r.out, 'RUN').some((l) => /heavy/.test(l)), tagLines(r.out, 'WINDOW').join(' | '));
check('COVER shows the window levels', /^COVER .*window ✓ 5h 20% 7d 91%/m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('COVER')).join(''));
fs.writeFileSync(limitRuns, JSON.stringify([
  { id: 'r1', chatId: 'c0b', sessionId: 's', startedAt: now8 - 60e3, endedAt: now8 - 30e3, tokens: 1000, samples: [sample(now8 - 30e3, 0.2, 0.91)] },
  { id: 'r2', chatId: 'c0b', sessionId: 's', startedAt: now8 - 20e3, endedAt: now8 - 1e3, tokens: 4e6, samples: [sample(now8 - 1e3, 0.3, 0.92)] },
]));
r = await run(WATCH, [...common, '--once']);
check('RUN: a heavy run of a watched group is hi with its window share', tagLines(r.out, 'RUN').some((l) => /g0-p1aaaa RUN 4000k tok in 19s · 5h 30% \(\+10% while it ran\) · 7d 92% \(\+1%\) — heavy/.test(l)), tagLines(r.out, 'RUN').join(' | '));
check('WINDOW is not repeated at the same level', !tagLines(r.out, 'WINDOW').length, tagLines(r.out, 'WINDOW').join(' | '));
// A record the panel writes mid-run (`open`) is no RUN; the run's end, the same id rewritten without it, is (25.10 #g3:84).
const runsSoFar = JSON.parse(fs.readFileSync(limitRuns, 'utf8'));
const r3 = { id: 'r3', chatId: 'c0b', sessionId: 's', startedAt: now8 - 900e3, tokens: 63e3, samples: [sample(now8 - 900e3, 0.3, 0.92)] };
fs.writeFileSync(limitRuns, JSON.stringify([...runsSoFar, { ...r3, endedAt: now8 - 880e3, open: true }]));
r = await run(WATCH, [...common, '--once']);
check('RUN: a record written mid-run is not a finished run', !tagLines(r.out, 'RUN').length, tagLines(r.out, 'RUN').join(' | '));
fs.writeFileSync(limitRuns, JSON.stringify([...runsSoFar, { ...r3, endedAt: now8 - 500, tokens: 90e3 }]));
r = await run(WATCH, [...common, '--once']);
check('RUN: the same run is shown once it ends, with its whole length', tagLines(r.out, 'RUN').some((l) => /g0-p1aaaa RUN 90k tok in 15m/.test(l)), tagLines(r.out, 'RUN').join(' | '));
// A stage start runs under a pending `new-*` key no snapshot holds: its session's transcript in the unit's dir names
// the unit (26.10 g9: five stage runs, ~104M tokens, went to `other`); a session found nowhere stays unattributed.
const runsNew = JSON.parse(fs.readFileSync(limitRuns, 'utf8'));
fs.writeFileSync(limitRuns, JSON.stringify([...runsNew,
  { id: 'new-1:1', chatId: 'new-1', sessionId: path.basename(tf, '.jsonl'), startedAt: now8 - 400, endedAt: now8 - 300, tokens: 5e6, samples: [sample(now8 - 300, 0.3, 0.92)] },
  { id: 'new-2:1', chatId: 'new-2', sessionId: 'nowhere0-1111-2222-3333-444444444444', startedAt: now8 - 250, endedAt: now8 - 200, tokens: 6e6, samples: [sample(now8 - 200, 0.3, 0.92)] },
]));
r = await run(WATCH, [...common, '--once']);
check('RUN: a stage-start run under a pending key is attributed by its transcript', tagLines(r.out, 'RUN').some((l) => /g0-p1aaaa RUN 5000k tok/.test(l)) && !tagLines(r.out, 'RUN').some((l) => /6000k/.test(l)), tagLines(r.out, 'RUN').join(' | '));
// The sample before a run hours old sits in an older window: the reset since is not this run's spend — its own first
// sample is the start (g1 26.10: «+49% while it ran» for 46 → 49 %, armed as heavy).
{
  const runsKept = fs.readFileSync(limitRuns, 'utf8');
  const oldWin = { at: now8 - 5 * 3600e3, fiveHour: { utilization: 0.9, resetsAt: Math.round(now8 / 1000) - 3600 }, sevenDay: { utilization: 0.5, resetsAt: Math.round(now8 / 1000) + 86400 } };
  fs.writeFileSync(limitRuns, JSON.stringify([
    { id: 'old5h', chatId: 'c0b', sessionId: 's', startedAt: oldWin.at - 60e3, endedAt: oldWin.at, tokens: 1000, samples: [oldWin] },
    { id: 'fresh', chatId: 'c0b', sessionId: 's', startedAt: now8 - 900e3, endedAt: now8 - 100, tokens: 2e6, samples: [sample(now8 - 880e3, 0.46, 0.5), sample(now8 - 100, 0.49, 0.5)] },
  ]));
  r = await run(WATCH, [...common, '--once']);
  check('RUN: a sample hours old in an older window is no baseline — the run\'s own first sample is', tagLines(r.out, 'RUN').some((l) => /2000k tok in 15m · 5h 49% \(\+3% while it ran\)/.test(l) && !/heavy/.test(l)), tagLines(r.out, 'RUN').join(' | '));
  // Groups run together: a neighbour's sample after this run started is its middle, not its start (g1 27.10: «+1%»
  // for 9 → 20 % — the base was g9's last sample, taken 59 min into g1's run).
  fs.writeFileSync(limitRuns, JSON.stringify([
    { id: 'ovA', chatId: 'c0b', sessionId: 's', startedAt: now8 - 600e3, endedAt: now8 - 200e3, tokens: 1000, samples: [sample(now8 - 590e3, 0.09, 0.5), sample(now8 - 200e3, 0.19, 0.5)] },
    { id: 'ovB', chatId: 'c0b', sessionId: 's', startedAt: now8 - 610e3, endedAt: now8 - 100e3, tokens: 1000, samples: [sample(now8 - 605e3, 0.09, 0.5), sample(now8 - 100e3, 0.2, 0.5)] },
  ]));
  r = await run(WATCH, [...common, '--once']);
  check('RUN: overlapping runs — each moves from its own start, not from the neighbour\'s end', tagLines(r.out, 'RUN').some((l) => /5h 19% \(\+10% while it ran\)/.test(l)) && tagLines(r.out, 'RUN').some((l) => /5h 20% \(\+11% while it ran\)/.test(l)), tagLines(r.out, 'RUN').join(' | '));
  // The window checks below read the level the earlier runs left.
  fs.writeFileSync(limitRuns, runsKept);
}
// A D-n of a watched group waits for the human while the group works on: its status never shows it (25.10 D-3).
const deferred = path.join(ad, 'deferred-asks.json');
const ask = (id, scope, state = 'waiting') => ({ id, state, kind: 'permission', scope, toolName: 'Bash', input: { command: `docker exec "$CID" go test ./x # ${id}` }, reasonCode: 'group-rows', askedAt: new Date().toISOString() });
fs.writeFileSync(deferred, JSON.stringify({ version: 1, next: 4, records: [
  ask('D-1', { kind: 'group', parentChatId: P, groupIndex: 0 }, 'allowed'),
  ask('D-2', { kind: 'group', parentChatId: 'other-split', groupIndex: 0 }),
  ask('D-3', { kind: 'group', parentChatId: P, groupIndex: 0 }),
] }));
r = await run(WATCH, [...common, '--once']);
check('DEFER: a waiting D-n of a watched group is hi with its command; answered and foreign ones are not', tagLines(r.out, 'DEFER').length === 1 && tagLines(r.out, 'DEFER').some((l) => /g0-p1aaaa DEFER D-3 Bash waits for the human \(group-rows\): docker exec "\$CID" go test/.test(l)), tagLines(r.out, 'DEFER').join(' | '));
check('COVER counts the waiting D-n', /^COVER .*D-n ✓ 1 waiting/m.test(r.out), r.out.split('\n').filter((l) => l.startsWith('COVER')).join(''));
fs.writeFileSync(deferred, JSON.stringify({ version: 1, next: 4, records: [ask('D-3', { kind: 'group', parentChatId: P, groupIndex: 0 })] }));
r = await run(WATCH, [...common, '--once']);
check('DEFER is not repeated for the same D-n', !tagLines(r.out, 'DEFER').length, tagLines(r.out, 'DEFER').join(' | '));
fs.rmSync(deferred);
// A fresh watch over g0 alone (pausable, SAFE, never armed here): the window's level arms it with no flag of its own.
const k8 = seen.length;
r = await run(WATCH, ['--state', path.join(out, 'state4'), '--app-data', ad, '--config-root', cfg, '--repo', repo, '--group', `${P}:0`, '--once', ...ctl]);
check('WINDOW arms every watched group, even one with no flag of its own', seen.length === k8 + 1 && tagLines(r.out, 'PAUSED').some((l) => /^\S+ g0 PAUSED at safe point .* for WINDOW window #—:\d+: HTTP 200/.test(l)), `${seen.length - k8}: ${tagLines(r.out, 'PAUSED').join(' | ')} ${r.out.split('\n').filter((l) => l.startsWith('[g0')).join('')}`);
{
  // 26.10 #g9:133–135: the panel moved the group to a clean session not born yet; the old transcript read SAFE and
  // the armed pause cut the handoff 1.7 s in. An arm waits for the birth.
  const chatWas = g0.chatId;
  g0.chatId = 'new-1792961338110';
  saveState();
  const k8b = seen.length;
  r = await run(WATCH, ['--state', path.join(out, 'state4u'), '--app-data', ad, '--config-root', cfg, '--repo', repo, '--group', `${P}:0`, '--once', ...ctl]);
  check('an armed group moved to an unborn conversation is not paused', seen.length === k8b && !tagLines(r.out, 'PAUSED').length && /ARMED pause at safe point \(WINDOW/.test(r.out.split('\n').find((l) => l.startsWith('[g0')) ?? ''), `${seen.length - k8b}: ${tagLines(r.out, 'PAUSED').join(' | ')} ${r.out.split('\n').filter((l) => l.startsWith('[g0')).join('')}`);
  g0.chatId = chatWas;
  saveState();
}
// The last sample's window has reset since (25.10: 97 % from 19:48, reset 21:00, flagged 13 h later): no level, no pause.
const pastReset = { utilization: 0.97, resetsAt: Math.round(now8 / 1000) - 3600 };
fs.writeFileSync(limitRuns, JSON.stringify([{ id: 'r8', chatId: 'c0b', sessionId: 's', startedAt: now8 - 9e6, endedAt: now8 - 8e6, tokens: 1000, samples: [{ at: now8 - 8e6, fiveHour: pastReset, sevenDay: pastReset }] }]));
r = await run(WATCH, ['--state', path.join(out, 'state4b'), '--app-data', ad, '--config-root', cfg, '--repo', repo, '--group', `${P}:0`, '--once', ...ctl]);
check('WINDOW: a sample whose window has reset since raises nothing and pauses nothing', !tagLines(r.out, 'WINDOW').length && !tagLines(r.out, 'PAUSED').some((l) => /for WINDOW/.test(l)) && /^COVER .*window ✓ 5h reset since the last run 7d reset since the last run/m.test(r.out), `${tagLines(r.out, 'WINDOW').join(' | ')} · ${tagLines(r.out, 'PAUSED').join(' | ')} · ${r.out.split('\n').filter((l) => l.startsWith('COVER')).join('')}`);

// 9. A conveyor that stopped (IDLE), and the review budget an audit line carries (state S5, groups 4-6).
fs.writeFileSync(limitRuns, JSON.stringify([{ id: 'r9', chatId: 'c0b', sessionId: 's', startedAt: now8 - 60e3, endedAt: now8 - 30e3, tokens: 1000, samples: [sample(now8 - 30e3, 0.1, 0.1)] }]));
const endedGroup = (i, agoMs, extra = {}) => {
  const dir = path.join(out, `copy${i}`);
  const td = path.join(cfg, 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(td, { recursive: true });
  const t0 = Date.now() - agoMs;
  const line = (r, dt) => JSON.stringify({ sessionId: `c${i}`, cwd: dir, timestamp: new Date(t0 + dt).toISOString(), ...r });
  fs.writeFileSync(path.join(td, `c${i}aaaaaa-1111-2222-3333-444444444444.jsonl`), `${[
    line({ type: 'user', message: { role: 'user', content: `Group ${i} brief` } }, -2000),
    line({ type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Stage done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000 } } }, 0),
  ].join('\n')}\n`);
  const g = { index: i, title: `G${i}`, status: 'started', path: dir, chatId: `c${i}`, stageTrace: [{ stage: 'work', at: new Date(t0 - 60e3).toISOString() }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null, ...extra };
  state.splitPlans[P].groups.push(g);
  return g;
};
const g4 = endedGroup(4, 20 * 60e3);
endedGroup(5, 20 * 60e3, { status: 'awaiting', waitingFor: 'decision' });
endedGroup(6, 60e3);
saveState();
const SID9 = `selftest9-${process.pid}`;
const home9 = path.join(out, 'home9');
// The counter and grant store this copy reads: a personal layer → <home>/.claude/cache; a kit copy → the kit hooks'
// state dir (stamps/ + grants/), pointed at a temp dir through AGENTDECK_KIT_STATE.
const kit9 = path.join(out, 'kit9');
const KIT = !!kitRoot();
const cache9 = KIT ? path.join(kit9, 'stamps') : path.join(home9, '.claude', 'cache');
const grants9 = KIT ? path.join(kit9, 'grants') : path.join(cache9, 'grants');
fs.mkdirSync(cache9, { recursive: true });
fs.mkdirSync(grants9, { recursive: true });
fs.writeFileSync(path.join(cache9, `review-spawns-${SID9.slice(0, 12)}.txt`), '38');
const env9 = { CLAUDE_CODE_SESSION_ID: SID9, USERPROFILE: home9, HOME: home9, AGENTDECK_KIT_STATE: kit9 };
process.env.AGENTDECK_KIT_STATE = kit9;
const c5 = ['--state', path.join(out, 'state5'), '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
r = await run(WATCH, [...c5, '--group', `${P}:4`, '--group', `${P}:5`, '--group', `${P}:6`, '--from', 'start', '--once'], env9);
const idle9 = tagLines(r.out, 'IDLE');
check('IDLE: a started group whose turn ended 20 min ago with nothing open', idle9.length === 1 && /^\S+ g4 IDLE turn ended 20m ago, nothing open, the panel still shows started — no next turn started/.test(idle9[0] ?? '') && /hi [1-9]/.test(r.out), `${idle9.join(' | ')} ${r.out.slice(0, 200)}`);
check('no IDLE on a human wait or a turn that ended a minute ago', !idle9.some((l) => / g[56] IDLE /.test(l)), idle9.join(' | '));
g4.stageTrace = [...g4.stageTrace, { stage: 'review', at: new Date().toISOString() }];
saveState();
await new Promise((res) => setTimeout(res, 4100));
r = await run(WATCH, [...c5, '--once'], env9);
check('IDLE once per ended turn', !tagLines(r.out, 'IDLE').length, tagLines(r.out, 'IDLE').join(' | '));
check('the audit line names the review budget left', tagLines(r.out, 'STAGE').some((l) => /audit: spawn «review: watch audit g4 work» .*\(review budget 2\/40 left\)(?: #\S+)?$/.test(l)), tagLines(r.out, 'STAGE').join(' | '));
const { reviewBudget } = await import('./lib/common.mjs');
fs.writeFileSync(path.join(cache9, `review-spawns-${SID9.slice(0, 12)}.txt`), '40');
check('review cap reached with no grant: audit it yourself or the grant phrase', /^review cap 40 reached, no grant: run the pack and audit it yourself .*«агенты без вопроса на N ч»$/.test(reviewBudget(SID9, home9)), reviewBudget(SID9, home9));
fs.writeFileSync(path.join(grants9, `spawn-${SID9}.json`), JSON.stringify({ from: new Date().toISOString(), until: new Date(Date.now() + 90 * 60e3).toISOString() }));
check('review cap reached under a live grant names how long it runs', /^review cap 40 reached, the owner's spawn grant runs (89|90) min more$/.test(reviewBudget(SID9, home9)), reviewBudget(SID9, home9));
check('no session: no budget part', reviewBudget('', home9) === '');
{
  // Each layer reads its own guard's counter: personal 40 (cap) vs kit 5 — never the other one's.
  const homeX = path.join(out, 'homeX');
  const kitX = path.join(out, 'kitX');
  fs.mkdirSync(path.join(homeX, '.claude', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(kitX, 'stamps'), { recursive: true });
  fs.writeFileSync(path.join(homeX, '.claude', 'cache', `review-spawns-${SID9.slice(0, 12)}.txt`), '40');
  fs.writeFileSync(path.join(kitX, 'stamps', `review-spawns-${SID9.slice(0, 12)}.txt`), '5');
  process.env.AGENTDECK_KIT_STATE = kitX;
  check('kit copy: the review budget comes from the kit hooks\' counter (<kit state>/stamps)', reviewBudget(SID9, homeX, Date.now(), true) === 'review budget 35/40 left', reviewBudget(SID9, homeX, Date.now(), true));
  check('personal copy: the review budget comes from <home>/.claude/cache', /^review cap 40 reached/.test(reviewBudget(SID9, homeX, Date.now(), false)), reviewBudget(SID9, homeX, Date.now(), false));
  process.env.AGENTDECK_KIT_STATE = kit9;
}

// 10. A turn the panel cut: the process is gone, the transcript stops mid-turn with no end record (g8 26.10: paused
// 00:08, footer busy(turn running) + STALL at 00:52). Paused = ended at its last record; started = still busy + STALL.
const cutGroup = (i, status) => {
  const g = endedGroup(i, 13 * 60e3, { status });
  const td = path.join(cfg, 'projects', path.resolve(g.path).replace(/[^a-zA-Z0-9]/g, '-'));
  const at = new Date(Date.now() - 13 * 60e3).toISOString();
  const cut = { sessionId: `c${i}`, cwd: g.path, timestamp: at, type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: null, content: [{ type: 'text', text: 'Reading the review…' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000 } } };
  fs.writeFileSync(path.join(td, `c${i}aaaaaa-1111-2222-3333-444444444444.jsonl`), `${JSON.stringify({ sessionId: `c${i}`, cwd: g.path, timestamp: at, type: 'user', message: { role: 'user', content: `Group ${i} brief` } })}\n${JSON.stringify(cut)}\n`);
};
cutGroup(7, 'paused');
cutGroup(8, 'started');
saveState();
const c10 = ['--state', path.join(out, 'state10'), '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
r = await run(WATCH, [...c10, '--group', `${P}:7`, '--group', `${P}:8`, '--from', 'start', '--once']);
const foot10 = (g) => r.out.split('\n').find((l) => l.startsWith(`[${g}]`)) ?? '';
check('a paused group whose turn was cut is SAFE at its last record, not busy', /^\[g7\] SAFE ended 13m ago \(cut: paused\)/.test(foot10('g7')), foot10('g7'));
// STALL counts from the read that saw the file grow: a second call past a 1-s --stall.
await new Promise((res) => setTimeout(res, 1100));
r = await run(WATCH, [...c10, '--stall', '1', '--once']);
check('a paused group whose turn was cut raises no STALL', !tagLines(r.out, 'STALL').some((l) => / g7 STALL /.test(l)), tagLines(r.out, 'STALL').join(' | '));
check('a started group with the same transcript stays busy + STALL', /^\[g8\] busy\(turn running\)/.test(foot10('g8')) && tagLines(r.out, 'STALL').some((l) => / g8 STALL /.test(l)), `${foot10('g8')} · ${tagLines(r.out, 'STALL').join(' | ')}`);

// 11. Where the panel lives (lib/panel.mjs): flags > the panel's own answer > the stock layout; the rule-text snapshot
// when the watch runs outside the panel's repo.
{
  const { discoverAppData, panelBase, panelTokenFile } = await import('./lib/panel.mjs');
  const statusLine = new RegExp(`^${P}:0 \\S+ · stage `, 'm');
  let lc = located.length;
  r = await run(CTRL, ['status', '--group', `${P}:0`, ...ctl]);
  check('discovery: status with no --app-data reads the dir the panel names, asking with the credential', r.code === 0 && statusLine.test(r.out) && located.length === lc + 1 && located.at(-1).auth === `Bearer ${FAKE}`, `${r.out} located ${located.length - lc}`);
  check('discovery: the credential never reaches the output', !r.out.includes(FAKE), r.out);
  lc = located.length;
  r = await run(CTRL, ['status', '--group', `${P}:0`, '--config-root', cfg, ...ctl]);
  check('discovery: --config-root names the dir, no question to the panel', r.code === 0 && statusLine.test(r.out) && located.length === lc, `${r.out} located ${located.length - lc}`);
  lc = located.length;
  r = await run(CTRL, ['status', '--group', `${P}:0`, '--app-data', ad, ...ctl]);
  check('discovery: --app-data wins, no question to the panel', r.code === 0 && located.length === lc, `located ${located.length - lc}`);
  // The watch: the panel's answer feeds state.json, and the next-call command does not pin it as a flag.
  lc = located.length;
  const S11 = path.join(out, 'state11');
  r = await run(WATCH, ['--state', S11, '--repo', repo, '--group', `${P}:0`, '--once', ...ctl], { CLAUDE_CONFIG_DIR: cfg });
  check('discovery: a watch with no --app-data reads state.json where the panel says', r.code === 0 && /^COVER state ✓ /m.test(r.out) && located.length === lc + 1, `${r.out.split('\n').filter((l) => l.startsWith('COVER') || l.startsWith('cannot')).join('')} located ${located.length - lc}`);
  const flagged = [];
  const never = async () => {
    flagged.push(1);
    throw new Error('no call expected');
  };
  check('discovery: --app-data beats every other source', (await discoverAppData({ 'app-data': ad, 'config-root': cfg }, { fetchImpl: never })).from === 'flag' && !flagged.length);
  const cr = await discoverAppData({ 'config-root': cfg }, { fetchImpl: never });
  check('discovery: --config-root → <it>/agentdeck, no request', cr.from === 'config-root' && cr.dir === path.resolve(ad) && !flagged.length, JSON.stringify(cr));
  const down = await discoverAppData({}, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  check('discovery: panel down → the stock dir under the config root', down.from === 'default' && down.dir === path.resolve(configRoot({}), 'agentdeck'), JSON.stringify(down));
  const gated = await discoverAppData({}, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  check('discovery: a refusal (401) → the stock dir, never a guess from the body', gated.from === 'default', JSON.stringify(gated));
  const odd = await discoverAppData({}, { fetchImpl: async () => ({ ok: true, json: async () => ({ paths: {} }) }) });
  check('discovery: an answer with no appData → the stock dir', odd.from === 'default', JSON.stringify(odd));
  check('panel URL: --base > AGENTDECK_URL > PORT > 5178', panelBase({ base: 'http://a:1/' }, { AGENTDECK_URL: 'http://b:2' }) === 'http://a:1' && panelBase({}, { AGENTDECK_URL: 'http://b:2/', PORT: '7' }) === 'http://b:2' && panelBase({}, { PORT: '6001' }) === 'http://127.0.0.1:6001' && panelBase({}, {}) === 'http://127.0.0.1:5178');
  const homeT = path.join(out, 'homeT');
  const legacyDir = path.join(homeT, `.${['claude', 'control'].join('-')}`);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'api-token'), 'x');
  check('credential: only the pre-rename home has one → that file', panelTokenFile({}, homeT) === path.join(legacyDir, 'api-token'), panelTokenFile({}, homeT));
  fs.mkdirSync(path.join(homeT, '.agentdeck'), { recursive: true });
  fs.writeFileSync(path.join(homeT, '.agentdeck', 'api-token'), 'y');
  check('credential: ~/.agentdeck wins over the pre-rename home; --token-file over both', panelTokenFile({}, homeT) === path.join(homeT, '.agentdeck', 'api-token') && panelTokenFile({ 'token-file': credFile }, homeT) === credFile);
  // Rule texts: the repo's module when there is one, else the snapshot shipped beside the scripts.
  const shipped = Object.keys(JSON.parse(fs.readFileSync(path.join(here, 'rule-texts.json'), 'utf8')).texts).length;
  const bare = path.join(out, 'bare-repo');
  fs.mkdirSync(bare, { recursive: true });
  r = await run(WATCH, ['--state', path.join(out, 'state11b'), '--app-data', ad, '--config-root', cfg, '--repo', bare, '--group', `${P}:0`, '--once', ...ctl]);
  check('rule texts: outside the panel repo the shipped snapshot is read', shipped > 30 && new RegExp(`rule texts ✓ ${shipped} `).test(r.out), `${shipped} ${r.out.split('\n').filter((l) => l.startsWith('COVER')).join('')}`);
  const snap = spawnSync(process.execPath, [path.join(here, 'rule-texts.mjs'), '--repo', repo, '--check'], { encoding: 'utf8' });
  check('rule texts: --check names the ids the snapshot lacks or differs on, exit 1', snap.status === 1 && /stale: .*\bR1\b/.test(snap.stdout) && !/\bR18\b/.test(snap.stdout), snap.stdout);
}

// 12. P6 (27.10): the panel's WSIG of a rule and our flag of the same finding, same group, same call, are one finding:
// our text rides on the WSIG line, owes no row, and its waste arms the pause citing the WSIG. A group with no WSIG of
// that rule keeps our flag (the fallback). A variant (R38done) reads its own text, written on the line after its key.
fs.writeFileSync(path.join(repo, 'apps/web/src/shared/config/i18n/group-watch/en.ts'), "export const x = {\n  rule: {\n    R4: 'Check re-run on an unchanged tree: {{check}}',\n    R18: 'Guards keep refusing — denials: {{denials}} within {{spanMin}} min',\n    R38: 'Dev server restarting: {{file}}',\n    R38done:\n      'Dev server back after {{sec}} s',\n  },\n};\n");
const p6 = [10, 11].map((i) => {
  const dir = path.join(out, `copyP6-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  state.splitPlans[P].groups.push({ index: i, title: `G${i}`, status: 'started', path: dir, chatId: `c${i}`, stageTrace: [{ stage: 'work', at: new Date(Date.now() - 600e3).toISOString() }], deliveryNudges: 0, deliveryMissing: [], deliveryHistory: [], mr: null });
  const td = path.join(cfg, 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(td, { recursive: true });
  const tf = path.join(td, `c${i}aaaaaa-1111-2222-3333-444444444444.jsonl`);
  let clock = Date.now() - 120e3;
  const rec = (x) => fs.appendFileSync(tf, `${JSON.stringify({ sessionId: `c${i}`, cwd: dir, timestamp: new Date((clock += 2000)).toISOString(), ...x })}\n`);
  rec({ type: 'user', message: { role: 'user', content: `Group ${i} brief` } });
  // Each run went through the legend: no GAP, RERUN is the one finding.
  const lint = (id, kind) => {
    rec({ type: 'assistant', message: { id: `m${++n}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm lint' } }], usage: { input_tokens: 5, cache_read_input_tokens: 2000 } } });
    ev({ repo: dir, check: 'eslint', key: `p6-${i}`, kind, ...(kind === 'hit' ? { savedMs: 100 } : { exit: 0, ms: 1 }), at: clock + 500 });
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  };
  return { i, lint };
});
saveState();
const c12 = ['--state', path.join(out, 'state12'), '--app-data', ad, '--config-root', cfg, '--repo', repo, ...ctl];
r = await run(WATCH, [...c12, '--group', `${P}:10`, '--group', `${P}:11`, '--from', 'start', '--once']);
for (const g of p6) {
  g.lint(`l${g.i}a`, 'record');
  g.lint(`l${g.i}b`, 'hit');
}
state.groupWatchSignals[P][10] = {
  signals: [
    { id: 'p6a', rule: 'R4', severity: 'warn', stage: 'work', params: { check: 'pnpm lint' } },
    { id: 'p6b', rule: 'R38', textKey: 'groupWatch.rule.R38done', severity: 'info', stage: 'work', numbers: { sec: 7 } },
  ],
};
saveState();
// The pending restart goes away in the same call: a plain mid RESTART with no waste, beside g10's R38 WSIG.
fs.rmSync(path.join(ad, 'dev-restart.json'));
// The ledger dir only on this call: the first one owes nothing, so this one is not refused.
const L12 = path.join(out, 'ledger12');
fs.mkdirSync(L12, { recursive: true });
r = await run(WATCH, [...c12, '--ledger-dir', L12, '--once']);
{
  const foot = (g) => r.out.split('\n').find((l) => l.startsWith(`[${g}]`)) ?? '';
  const wsig = tagLines(r.out, 'WSIG').filter((l) => / g10 WSIG R4 /.test(l));
  check('P6: our RERUN rides on the panel WSIG R4 of the same group', wsig.length === 1 && wsig[0].includes('Check re-run on an unchanged tree: pnpm lint') && /\+RERUN: pnpm lint again with no edit/.test(wsig[0]), tagLines(r.out, 'WSIG').join(' | '));
  check('P6: the folded RERUN leaves the digest', !tagLines(r.out, 'RERUN').some((l) => / g10 RERUN /.test(l)), tagLines(r.out, 'RERUN').join(' | '));
  const ref = wsig[0]?.match(/#g10:\d+$/)?.[0];
  check('P6: its waste arms the pause citing the WSIG', !!ref && foot('g10').includes(`ARMED pause at safe point (WSIG R4 rerun ${ref})`), `${ref} · ${foot('g10')}`);
  const owed = r.out.split('\n').find((l) => l.startsWith('rows owed before the next call:')) ?? '';
  const refs = owed.match(/#[^\s:]+:\d+/g) ?? [];
  const shown = new Set(r.out.split('\n').filter((l) => /^\d\d:\d\d:\d\d \S+ \S+ /.test(l)).flatMap((l) => l.match(/#[^\s:]+:\d+/g) ?? []));
  check('P6: every row owed cites a line the digest shows', refs.includes(ref) && refs.every((x) => shown.has(x)), `${owed} · shown ${[...shown].join(' ')}`);
  check('P6: no WSIG of the rule → our flag stands and arms as itself (the fallback)', tagLines(r.out, 'RERUN').some((l) => / g11 RERUN /.test(l)) && /ARMED pause at safe point \(RERUN rerun #g11:\d+\)/.test(foot('g11')), `${tagLines(r.out, 'RERUN').join(' | ')} · ${foot('g11')}`);
  check('P6: a flag that is no finding (restart cleared) stands beside the WSIG of its rule', tagLines(r.out, 'RESTART').some((l) => /pending restart cleared/.test(l)) && !tagLines(r.out, 'WSIG').some((l) => /\+RESTART/.test(l)), `${tagLines(r.out, 'RESTART').join(' | ')} · ${tagLines(r.out, 'WSIG').join(' | ')}`);
  check('P6: a variant signal reads its own text, written on the line after its key', tagLines(r.out, 'WSIG').some((l) => / g10 WSIG R38 info work: Dev server back after 7 s/.test(l)), tagLines(r.out, 'WSIG').join(' | '));
}

server.close();
fs.rmSync(out, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `\n${fails.map((f) => `  - ${f}`).join('\n')}` : ''}`);
process.exitCode = fails.length ? 1 : 0;
