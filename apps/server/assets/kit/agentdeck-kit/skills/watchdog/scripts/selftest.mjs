#!/usr/bin/env node
// Self-test of the watch through its real entry point (watch.mjs as a child process) over a fixture transcript
// tree that carries every flag shape. Asserts each flag fires, each negative stays silent, offsets persist, the
// lock and the copy refusal hold, and the three wake paths (hi / batch / max) end the call.
//   node selftest.mjs [--script <watch.mjs>] [--keep]        exit 0 = all green, 1 = a check failed
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const SCRIPT = path.resolve(opt('script') ?? path.join(here, 'watch.mjs'));
const SHOW = path.join(here, 'show.mjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-selftest-'));
const copy = path.join(out, 'copy');
fs.mkdirSync(copy, { recursive: true });
const pdir = path.join(out, 'projects', path.resolve(copy).replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(pdir, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
// The selftest's own session never registers as a watcher (keepalive): its id is stripped from every spawn.
const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;
const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--config-root', out], { encoding: 'utf8', timeout: 60000, env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status };
};
const lines = (o, tag) => o.split('\n').filter((l) => new RegExp(`^\\d\\d:\\d\\d:\\d\\d \\S+ ${tag.replace(/[+!]/g, '\\$&')} `).test(l));

// ---- fixture builders ----
let clock = Date.now() - 40 * 60e3;
const ts = (plusSec = 1) => new Date((clock += plusSec * 1000)).toISOString();
const base = (sid) => ({ sessionId: sid, cwd: copy, version: '2.1.310', uuid: Math.random().toString(36).slice(2) });
let msg = 0;
const A = (sid, content, extra = {}) => ({
  ...base(sid), type: 'assistant', timestamp: ts(), ...extra.rec,
  message: { id: `msg_${++msg}`, model: extra.model ?? 'claude-opus-5-5', role: 'assistant', stop_reason: extra.stop ?? 'tool_use', content, usage: extra.usage ?? { input_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 } },
});
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const R = (sid, id, content, extra = {}) => ({
  ...base(sid), type: 'user', timestamp: ts(extra.after ?? 1), ...extra.rec,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: extra.err ?? false }] },
  ...(extra.tur ? { toolUseResult: extra.tur } : {}),
});
const U = (sid, text, rec = {}) => ({ ...base(sid), type: 'user', timestamp: ts(), message: { role: 'user', content: text }, ...rec });
const write = (f, recs) => fs.appendFileSync(f, recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
const call = (sid, id, name, input, result, extra = {}) => [A(sid, [tool(id, name, input)], extra.a ?? {}), R(sid, id, result, extra)];

const SA = 'aaaaaaaa-1111-2222-3333-444444444444';
const fA = path.join(pdir, `${SA}.jsonl`);
const fileX = path.join(copy, 'src', 'x.ts');
// An alias the copy's tsconfig maps (comment + trailing comma: tsconfig is loose JSON) — an IDE artifact (#g5:389).
fs.writeFileSync(path.join(copy, 'tsconfig.json'), '{\n  // paths\n  "compilerOptions": { "paths": { "@entities/*": ["./src/entities/*"], } }\n}\n');
fs.mkdirSync(path.join(copy, 'src', 'entities', 'agents'), { recursive: true });
fs.writeFileSync(path.join(copy, 'src', 'entities', 'agents', 'index.ts'), 'export {};\n');
const fileAlias = path.join(copy, 'src', 'pages', 'constants.ts');
const missing = (spec) => ({ message: `Cannot find module '${spec}' or its corresponding type declarations.`, severity: 'Error', range: { start: { line: 0 } } });
const fileY = path.join(copy, 'src', 'y.ts');
write(fA, [
  U(SA, 'Implement feature F in the copy'),
  ...call(SA, 't1', 'Bash', { command: 'pnpm lint' }, 'Exit code 1\nsrc/a.ts:3 lint rule no-bad-type violated', { err: true }),
  ...call(SA, 't2', 'Bash', { command: 'git push --force origin x' }, 'PreToolUse:Bash hook error: [ctx-guard] git-guard(force) force push refused', { err: true, rec: { toolDenialKind: 'hook', permissionDecision: { decision: 'reject', source: 'hook' } } }),
  ...call(SA, 't3', 'Bash', { command: 'git push --force origin x' }, 'pushed'),
  ...call(SA, 't4', 'Bash', { command: 'pnpm lint' }, 'Exit code 1\nsrc/a.ts:3 lint rule no-bad-type violated', { err: true }),
  ...call(SA, 't4c', 'Bash', { command: 'git log --oneline -3' }, 'abc one'),
  ...call(SA, 't4d', 'Bash', { command: 'git log --oneline -3' }, 'abc one'),
  ...call(SA, 't5', 'Read', { file_path: fileX }, '1 const a = 1'),
  ...call(SA, 't6', 'Read', { file_path: fileX }, '1 const a = 1'),
  ...call(SA, 't7', 'Edit', { file_path: fileX, old_string: 'a', new_string: 'b' }, 'ok'),
  ...call(SA, 't8', 'Read', { file_path: fileX }, '1 const b = 1'),
  ...call(SA, 't8b', 'Read', { file_path: path.join(copy, 'src', 'z.ts'), offset: 10, limit: 400 }, 'File content (11567 tokens) exceeds maximum allowed tokens (10000).', { err: true }),
  ...call(SA, 't8c', 'Read', { file_path: path.join(copy, 'src', 'z.ts'), offset: 10, limit: 400, allow_large: true }, '10 const z = 1'),
  ...call(SA, 't9', 'Bash', { command: 'grep -rn nothing-here src' }, 'Exit code 1', { err: true }),
  ...call(SA, 't10', 'Bash', { command: 'sleep 30 && echo done' }, 'done'),
  ...call(SA, 't10b', 'Bash', { command: 'CID=$(docker create --label claude.ephemeral=1 -w /src golang:1.25 sleep 600 | tail -1); docker start "$CID"' }, 'ok'),
  ...call(SA, 't11', 'Bash', { command: 'npm test' }, 'all 40 passed', { after: 150 }),
  ...call(SA, 't12', 'Bash', { command: 'pnpm e2e' }, 'Command timed out after 2m 0s', { err: true }),
  ...call(SA, 't13', 'Bash', { command: 'pnpm build' }, 'partial', { tur: { interrupted: true, stdout: 'partial', stderr: '' } }),
  ...call(SA, 't14', 'Bash', { command: 'cat big.log' }, 'x'.repeat(25000)),
  ...call(SA, 't14b', 'Bash', { command: 'pnpm test:all' }, 'Output too large, saved', { tur: { persistedOutputPath: 'C:/tmp/o.txt', persistedOutputSize: 52000, interrupted: false } }),
  A(SA, [{ type: 'text', text: 'Context step' }], { usage: { input_tokens: 10, cache_read_input_tokens: 64000, cache_creation_input_tokens: 0 } }),
  A(SA, [{ type: 'text', text: 'Context high' }], { usage: { input_tokens: 10, cache_read_input_tokens: 190000, cache_creation_input_tokens: 0 } }),
  A(SA, [{ type: 'text', text: 'Model switched' }], { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 190500, cache_creation_input_tokens: 0 } }),
  ...call(SA, 't15', 'Agent', { description: 'Fix X', subagent_type: 'general-purpose', run_in_background: true }, 'launched', { tur: { agentId: 'ag1', status: 'async_launched' } }),
  ...call(SA, 't16', 'Bash', { command: 'pnpm dev', run_in_background: true }, 'started bg1', { tur: { backgroundTaskId: 'bg1', stdout: '', stderr: '', interrupted: false } }),
  U(SA, '<task-notification>\n<task-id>bg1</task-id>\n<status>killed</status>\n<summary>Background command "pnpm dev" was killed</summary>\n</task-notification>'),
  // Stopped by TaskStop: no notification ever comes (g8 26.10).
  ...call(SA, 't16s', 'Bash', { command: 'grep -o stoppedgrep big.jsonl', run_in_background: true }, 'started bg2', { tur: { backgroundTaskId: 'bg2', stdout: '', stderr: '', interrupted: false } }),
  ...call(SA, 't16t', 'TaskStop', { task_id: 'bg2' }, '{"message":"Successfully stopped task: bg2"}'),
  { ...base(SA), type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: 'Please also fix Y while you are there' },
  U(SA, 'Please also fix Y while you are there'),
  U(SA, `Long brief: ${'z'.repeat(16000)}`),
  { ...base(SA), type: 'attachment', timestamp: ts(), attachment: { type: 'hook_additional_context', hookName: 'PreToolUse:Edit', content: ['# Doc placement rule'] } },
  { ...base(SA), type: 'attachment', timestamp: ts(), attachment: { type: 'diagnostics', files: [{ uri: 'file:///c/copy/src/x.ts', diagnostics: [{ message: "Cannot find name 'q'", severity: 'Error', range: { start: { line: 4 } } }, { message: 'unused', severity: 'Hint' }] }] } },
  { ...base(SA), type: 'attachment', timestamp: ts(), attachment: { type: 'diagnostics', files: [{ uri: fileAlias, diagnostics: [missing('@entities/agents')] }] } },
  { ...base(SA), type: 'attachment', timestamp: ts(), attachment: { type: 'diagnostics', files: [{ uri: pathToFileURL(fileAlias).href, diagnostics: [missing('@entities/agents'), missing('@entities/gone')] }] } },
  ...call(SA, 'tchain', 'Bash', { command: 'cd D:/src/copy && grep -rln "ItemsTable/constants\\|ItemsFilters/constants\\|periodStart\\|resolveKindFilter" docs-ui/content | head; node scripts/check_frontend.mjs > g1.log 2>&1; echo g1=$?' }, 'g1=0'),
  { ...base(SA), type: 'attachment', timestamp: ts(), attachment: { type: 'hook_blocking_error', hookName: 'Stop', blockingError: { blockingError: 'Tests block: cases not run', command: 'node tests-hook.mjs stop' } } },
  { ...base(SA), type: 'system', subtype: 'stop_hook_summary', timestamp: ts(), hookCount: 2, hookErrors: ['docs guard failed'], preventedContinuation: false },
  { ...base(SA), type: 'system', subtype: 'compact_boundary', timestamp: ts(), compactMetadata: { trigger: 'auto', preTokens: 220000, postTokens: 12000 } },
  U(SA, 'This session is being continued from a previous conversation.', { isCompactSummary: true }),
  // The first message after compaction re-counts the baseline (system, tools, summary): not a CTX+ step.
  A(SA, [{ type: 'text', text: 'Resumed' }], { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 47000 } }),
  // A real jump right after it still is.
  A(SA, [{ type: 'text', text: 'Big read after resume' }], { usage: { input_tokens: 10, cache_read_input_tokens: 47000, cache_creation_input_tokens: 25000 } }),
  ...call(SA, 't17', 'Read', { file_path: fileX }, '1 const b = 1'),
  ...call(SA, 't17b', 'Read', { file_path: fileY }, 'y'),
  ...call(SA, 't17c', 'Bash', { command: 'git checkout -- .' }, ''),
  ...call(SA, 't17d', 'Read', { file_path: fileY }, 'y'),
  // Real api_error records carry `rateLimits: null`: a key name must never make an upstream 502 a LIMIT.
  { ...base(SA), type: 'system', subtype: 'api_error', timestamp: ts(), level: 'error', error: { formatted: 'Connection dropped (ECONNRESET)', status: null, rateLimits: null }, retryAttempt: 1, maxRetries: 10 },
  { ...base(SA), type: 'system', subtype: 'api_error', timestamp: ts(), level: 'error', error: { message: '502 upstream', status: 502, formatted: '502 Upstream did not answer in 60 s', rateLimits: null }, retryAttempt: 1, maxRetries: 10 },
  { ...base(SA), type: 'system', subtype: 'api_error', timestamp: ts(), level: 'error', error: { formatted: '429 rate limit exceeded', status: 429, rateLimits: null }, retryAttempt: 1, maxRetries: 10 },
  A(SA, [{ type: 'text', text: "You've hit your session limit · resets 9:30pm" }], { model: '<synthetic>', stop: 'stop_sequence', rec: { isApiErrorMessage: true, error: 'rate_limit' } }),
  // 429 inside another number (a request id, a byte count) is no rate limit.
  A(SA, [{ type: 'text', text: 'API Error: 500 Internal server error · request req_014290ab' }], { model: '<synthetic>', stop: 'stop_sequence', rec: { isApiErrorMessage: true } }),
  ...call(SA, 't18', 'AskUserQuestion', { questions: [{ question: 'Which branch should I push to?' }] }, 'main'),
  A(SA, [{ type: 'text', text: 'I skipped the tests for now, will verify after merge.' }]),
  A(SA, [{ type: 'text', text: 'Теперь node_modules пропускается при копировании.' }]),
  A(SA, [{ type: 'text', text: 'Infra: the job log says `prepare_script could not run to completion`, nothing in the branch.' }]),
  A(SA, [{ type: 'text', text: 'The `e2e` suite was not run on this branch.' }]),
  { ...base(SA), type: 'weird-new-record', timestamp: ts() },
  'this line is {not json',
  U(SA, '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<summary>Agent "Fix X" completed</summary>\n</task-notification>'),
  A(SA, [{ type: 'text', text: 'Feature F is done and verified by pnpm test.' }], { stop: 'end_turn' }),
  { ...base(SA), type: 'system', subtype: 'turn_duration', timestamp: ts(), durationMs: 5000 },
]);
// Subagent of session A.
const subDir = path.join(pdir, SA, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, 'agent-ag1.meta.json'), JSON.stringify({ description: 'Fix X', finished: true }));
write(path.join(subDir, 'agent-ag1.jsonl'), [
  U(SA, 'You are a fix agent. Fix X.'),
  ...call(SA, 's1', 'Read', { file_path: fileX }, '1 const b = 1'),
  A(SA, [{ type: 'text', text: 'Fixed X in src/x.ts.' }], { stop: 'end_turn' }),
]);
// Unit b: one Bash left open past its own timeout — OPEN + STALL, footer busy.
const SB = 'bbbbbbbb-1111-2222-3333-444444444444';
const dirB = path.join(out, 'projects-b');
fs.mkdirSync(dirB, { recursive: true });
clock = Date.now() - 15 * 60e3;
write(path.join(dirB, `${SB}.jsonl`), [U(SB, 'Run the gate'), A(SB, [tool('b1', 'Bash', { command: 'pnpm gate', timeout: 60000 })])]);
// Unit l: plain log.
const logF = path.join(out, 'parity-queue.log');
fs.writeFileSync(logF, 'row P-01 queued\nERROR: port failed for codex\n');

const S = path.join(out, 'state');
const units = ['--unit', `a=dir:${pdir}`, '--unit', `b=dir:${dirB}`, '--unit', `l=log:${logF}`];
const r1 = run(['--state', S, ...units, '--from', 'start', '--once']);
const o1 = r1.out;
check('first run exits 0', r1.code === 0, `code ${r1.code}: ${o1.slice(0, 300)}`);
const want = ['NEWCONV', 'ERR', 'DENY', 'REPEAT', 'REREAD', 'SLEEP', 'SLOW', 'TIMEOUT', 'INTR', 'BIG', 'CTX+', 'CTXHI', 'MODEL', 'SPAWN', 'BG', 'BGDONE', 'INJECT', 'BRIEF', 'DIAG', 'HOOK', 'COMPACT', 'APIERR', 'LIMIT', 'ASK', 'WORD', 'UNKNOWN', 'PARSE', 'END', 'SUB', 'OPEN', 'STALL', 'LOG!', 'LOG'];
for (const t of want) check(`flag ${t} fires`, lines(o1, t).length > 0);
// Negatives.
check('an upstream 502 / ECONNRESET is APIERR, never LIMIT (rateLimits: null is a key, not a limit)', lines(o1, 'APIERR').length === 3 && lines(o1, 'APIERR').some((l) => /502 Upstream/.test(l)) && !lines(o1, 'LIMIT').some((l) => /502|ECONNRESET/.test(l)), `${lines(o1, 'APIERR').join(' | ')} || ${lines(o1, 'LIMIT').join(' | ')}`);
check('a 500 whose request id holds 429 is APIERR, not LIMIT', lines(o1, 'APIERR').some((l) => /req_014290ab/.test(l)) && !lines(o1, 'LIMIT').some((l) => /req_014290ab/.test(l)), `${lines(o1, 'APIERR').join(' | ')} || ${lines(o1, 'LIMIT').join(' | ')}`);
check('a 429 and a session limit are LIMIT', lines(o1, 'LIMIT').some((l) => /429 rate limit/.test(l)) && lines(o1, 'LIMIT').some((l) => /session limit/.test(l)), lines(o1, 'LIMIT').join(' | '));
check('a repeat of a DENIED call is not REPEAT', !lines(o1, 'REPEAT').some((l) => /git push/.test(l)), lines(o1, 'REPEAT').join(' | '));
check('REPEAT counts the second identical run', lines(o1, 'REPEAT').some((l) => /×2 'git log --oneline -3'/.test(l)), lines(o1, 'REPEAT').join(' | '));
check('a check run twice on one tree is RERUN, not REPEAT', lines(o1, 'RERUN').some((l) => /RERUN pnpm lint again with no edit/.test(l)) && !lines(o1, 'REPEAT').some((l) => /'pnpm lint'/.test(l)), lines(o1, 'RERUN').join(' | '));
check('a read after an Edit is not REREAD', lines(o1, 'REREAD').length === 1, lines(o1, 'REREAD').join(' | '));
check('a read after compaction is not REREAD', !lines(o1, 'REREAD').some((l) => /×[34]/.test(l)));
check('a read after a tree-changing Bash is not REREAD', !lines(o1, 'REREAD').some((l) => /y\.ts/.test(l)));
check('the retry of a Read that failed (over the token cap) is not REREAD', !lines(o1, 'REREAD').some((l) => /z\.ts/.test(l)) && lines(o1, 'ERR').some((l) => /z\.ts/.test(l)), lines(o1, 'REREAD').join(' | '));
check('a container command `docker create … sleep 600` is not SLEEP', lines(o1, 'SLEEP').length === 1 && !lines(o1, 'SLEEP').some((l) => /docker/.test(l)), lines(o1, 'SLEEP').join(' | '));
check('a compaction summary is not an INJECT', !lines(o1, 'INJECT').some((l) => /being continued/.test(l)));
check('grep exit 1 with no output is not ERR', !lines(o1, 'ERR').some((l) => /grep/.test(l)), lines(o1, 'ERR').join(' | '));
check('queued prompt + its user record = one INJECT', lines(o1, 'INJECT').filter((l) => /fix Y/.test(l)).length === 1);
check('a task-notification is not an INJECT', !lines(o1, 'INJECT').some((l) => /task-notification/.test(l)));
check('killed bg is hi BGDONE with its command', lines(o1, 'BGDONE').some((l) => /bg1 killed 'pnpm dev'/.test(l)));
check('a bg task stopped by TaskStop (no notification) is closed: no BGLONG', !lines(o1, 'BGLONG').some((l) => /bg2/.test(l)), lines(o1, 'BGLONG').join(' | '));
check('WORD skips a plain «пропускается»', !lines(o1, 'WORD').some((l) => /node_modules/.test(l)), lines(o1, 'WORD').join(' | '));
check('one WORD for the hedged sentence', lines(o1, 'WORD').filter((l) => /skipped the tests/.test(l)).length === 1);
check('WORD skips a word inside a code quote (#g1:137 `could not run` from a job log)', !lines(o1, 'WORD').some((l) => /prepare_script/.test(l)), lines(o1, 'WORD').join(' | '));
check('WORD still reads the words around a code span', lines(o1, 'WORD').some((l) => /`e2e` suite was not run/.test(l)), lines(o1, 'WORD').join(' | '));
check('CTX+ names the cause', lines(o1, 'CTX+').some((l) => /after /.test(l)));
check('the first message after compaction is not CTX+', !lines(o1, 'CTX+').some((l) => /→ 47/.test(l)), lines(o1, 'CTX+').join(' | '));
check('a jump right after the post-compaction message is CTX+', lines(o1, 'CTX+').some((l) => /→ 72/.test(l)), lines(o1, 'CTX+').join(' | '));
check('DENY names the guard', lines(o1, 'DENY').some((l) => /← git-guard/.test(l)), lines(o1, 'DENY').join(' | '));
check('subagent first prompt is not NEWCONV', lines(o1, 'NEWCONV').length === 2, lines(o1, 'NEWCONV').join(' | '));
// Owner 25.10: every action is its own line with its command or path — never a count, never «not shown».
check('every action listed', /^── every action \(\d+\) ──$/m.test(o1) && /^\S+ a CALL Bash 'pnpm lint'/m.test(o1) && /^\S+ a HINT /m.test(o1), o1.split('\n').filter((l) => / (CALL|HINT) /.test(l)).slice(0, 4).join(' | '));
check('no action collapsed or dropped', !/ calls \d|calls \(|not shown|more lines/.test(o1));
const tiny = run(['--state', `${S}-tiny`, ...units, '--from', 'start', '--once', '--budget', '500']).out;
check('over budget: same action count, only narrower', (tiny.match(/ CALL /g) ?? []).length === (o1.match(/ CALL /g) ?? []).length && (tiny.match(/ CALL /g) ?? []).length > 3);
check('unit a footer SAFE', /^\[a\] SAFE /m.test(o1), o1.split('\n').filter((l) => l.startsWith('[')).join(' | '));
check('unit b footer busy with the open call', /^\[b\] busy\(open Bash/m.test(o1));
check('every flag line carries a ref', lines(o1, 'DENY').every((l) => / #a:\d+$/.test(l)));
check('a chain whose check sits past the cut names it (#g5:390)', /CALL Bash \[runs scripts\/check_frontend\.mjs\] 'cd D:\/src\/copy && grep -rln /m.test(o1), o1.split('\n').filter((l) => /tchain|check_frontend/.test(l)).join(' | '));
check('DIAG on an alias the copy tsconfig resolves is lo (no ref); an unresolved one stays mid', !lines(o1, 'DIAG').some((l) => /@entities\/agents/.test(l) && / #a:\d+$/.test(l)) && lines(o1, 'DIAG').some((l) => /1 error\(s\): constants\.ts:1 Cannot find module '@entities\/gone'/.test(l) && / #a:\d+$/.test(l)), lines(o1, 'DIAG').join(' | '));

// show.mjs opens a ref with a positional read.
const ref = / (#a:\d+)$/.exec(lines(o1, 'DENY')[0] ?? '')?.[1];
const sh = spawnSync(process.execPath, [SHOW, '--state', S, ref ?? '#a:0', '--max', '400'], { encoding: 'utf8' });
check('show.mjs prints the denied tool_result by ref', /tool_result t2 is_error/.test(sh.stdout) && /toolDenialKind/.test(sh.stdout), sh.stdout.slice(0, 200));

// Offsets persist: a second call sees nothing; one appended record is the only flag.
const r2 = run(['--state', S, '--once']);
check('second call has no flags', /hi 0 mid 0/.test(r2.out), r2.out.split('\n')[0]);
clock = Date.now();
write(fA, [...call(SA, 't20', 'Edit', { file_path: fileX, old_string: 'zz', new_string: 'b' }, 'String to replace not found in file.', { err: true })]);
const r3 = run(['--state', S, '--once']);
check('only the appended record is flagged', /hi 1 mid 0/.test(r3.out) && lines(r3.out, 'ERR').length === 1, r3.out.split('\n')[0]);
check('a running turn with nothing open is busy, not SAFE', /^\[a\] busy\(turn running\)/m.test(r3.out), r3.out.split('\n').filter((l) => l.startsWith('[a]')).join(''));

// A new conversation file and a new subagent in an existing unit are read from byte 0.
const SC = 'cccccccc-1111-2222-3333-444444444444';
write(path.join(pdir, `${SC}.jsonl`), [U(SC, 'Stage 2 brief: review the diff')]);
fs.mkdirSync(path.join(pdir, SC, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(pdir, SC, 'subagents', 'agent-ag2.meta.json'), JSON.stringify({ description: 'Review lane' }));
write(path.join(pdir, SC, 'subagents', 'agent-ag2.jsonl'), [U(SC, 'review prompt')]);
const r4 = run(['--state', S, '--once']);
check('new conversation → NEWCONV', lines(r4.out, 'NEWCONV').some((l) => /cccccccc first prompt/.test(l)));
check('new subagent file → SUB started', lines(r4.out, 'SUB').some((l) => /started Review lane/.test(l)));

// A shrunken file is RESET and re-read.
fs.writeFileSync(logF, 'x\n');
const r5 = run(['--state', S, '--once']);
check('shrunken file → RESET', lines(r5.out, 'RESET').length === 1);

// Setup call on a live file: taken at its end, tail backlog shown, then nothing re-read.
const S2 = path.join(out, 'state2');
const r6 = run(['--state', S2, '--unit', `a=dir:${pdir}`]);
check('setup call returns at once with a backlog', /wake=setup/.test(r6.out) && /BACKLOG last \d+ flags/.test(r6.out), r6.out.split('\n')[0]);
const r7 = run(['--state', S2, '--once']);
check('after setup nothing old is re-flagged', /hi 0 mid 0/.test(r7.out), r7.out.split('\n')[0]);

// Lock held by a live pid → exit 3.
fs.writeFileSync(path.join(S2, 'watch.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
const r8 = run(['--state', S2, '--once']);
check('a held lock refuses with exit 3', r8.code === 3 && /locked by pid/.test(r8.out), `code ${r8.code}`);
fs.unlinkSync(path.join(S2, 'watch.lock'));

// State inside the watched copy → refused, nothing written there.
const inside = path.join(copy, '.agent', 'w');
const r9 = run(['--state', inside, '--unit', `a=dir:${pdir}`, '--once']);
check('state inside the watched copy is refused', r9.code === 2 && /refused: state dir/.test(r9.out) && !fs.existsSync(inside), `code ${r9.code}`);
const r9b = run(['--state', inside, '--unit', `c=cwd:${copy}`, '--once']);
check('cwd unit: state inside the copy is refused', r9b.code === 2 && !fs.existsSync(inside), `code ${r9b.code}`);
const r9c = run(['--state', path.join(out, 'state3'), '--unit', `c=cwd:${copy}`, '--from', 'start', '--once']);
check('cwd unit resolves projects/<slug>', lines(r9c.out, 'DENY').length > 0, r9c.out.split('\n')[0]);

// Wake paths: hi wakes after settle, mid after batch, quiet at max.
const timed = (args, act, ms) =>
  new Promise((done) => {
    const t0 = Date.now();
    const ch = spawn(process.execPath, [SCRIPT, ...args, '--config-root', out], { env });
    let o = '';
    ch.stdout.on('data', (d) => (o += d));
    setTimeout(act, ms);
    ch.on('close', () => done({ out: o, ms: Date.now() - t0 }));
  });
const S4 = path.join(out, 'state4');
run(['--state', S4, '--unit', `a=dir:${pdir}`]);
const w1 = await timed(['--state', S4, '--max', '30', '--settle', '1', '--poll', '0.2'], () => write(fA, [...call(SA, 't30', 'Bash', { command: 'pnpm lint --x' }, 'Exit code 2\nerror boom', { err: true })]), 800);
check('hi flag wakes after settle', /wake=hi/.test(w1.out) && w1.ms < 10000, `${w1.ms}ms ${w1.out.split('\n')[0]}`);
const w2 = await timed(['--state', S4, '--max', '30', '--batch', '1', '--poll', '0.2'], () => write(fA, [...call(SA, 't31', 'Bash', { command: 'sleep 2' }, 'ok')]), 800);
check('mid flag wakes after batch', /wake=batch/.test(w2.out) && w2.ms < 10000, `${w2.ms}ms ${w2.out.split('\n')[0]}`);
const w3 = await timed(['--state', S4, '--max', '2', '--poll', '0.2'], () => {}, 10);
check('quiet stretch ends at max', /wake=max/.test(w3.out) && w3.ms >= 1900 && w3.ms < 8000, `${w3.ms}ms`);

// Budget: a tiny budget narrows lines but keeps every hi and mid flag (owner 25.10: nothing dropped).
const S5 = path.join(out, 'state5');
const r10 = run(['--state', S5, '--unit', `a=dir:${pdir}`, '--from', 'start', '--once', '--budget', '1200']);
const S5w = path.join(out, 'state5w');
const r10w = run(['--state', S5w, '--unit', `a=dir:${pdir}`, '--from', 'start', '--once']);
const flagLines = (o) => o.split('\n').filter((l) => /^\d\d:\d\d:\d\d a (?!CALL |HINT )/.test(l)).length;
check('tight budget keeps every hi and mid flag', lines(r10.out, 'DENY').length > 0 && lines(r10.out, 'END').length > 0 && !/not shown/.test(r10.out) && flagLines(r10.out) === flagLines(r10w.out), `${flagLines(r10.out)} vs ${flagLines(r10w.out)}`);

// Git Bash form of a Windows path inside a unit spec (`name=log:/c/x`): MSYS converts only arguments that START
// with a path, so node receives `/c/...` verbatim. The unit must watch the real file, and a missing target is named.
const S6 = path.join(out, 'state6');
const logM = path.join(out, 'msys.log');
fs.writeFileSync(logM, 'start\n');
const msys = process.platform === 'win32' ? `/${logM[0].toLowerCase()}${logM.slice(2).replace(/\\/g, '/')}` : logM;
run(['--state', S6, '--unit', `m=log:${msys}`, '--once']);
fs.appendFileSync(logM, 'second line after setup\n');
const r11 = run(['--state', S6, '--once']);
check('Git Bash /c/… path in a unit spec watches the real file', lines(r11.out, 'LOG').some((l) => /second line after setup/.test(l)), r11.out.split('\n').slice(0, 3).join(' | '));
// A suite's summary line «12 passed, 0 failed» is a success; «1 failed» next to it is not.
fs.appendFileSync(logM, 'ok    economy-guards   135 passed, 0 failed\nok    lint   0 errors, 0 warnings\nFAIL  skill-hint   130 passed, 1 failed\n');
const r13 = run(['--state', S6, '--once']);
check('zero-count summary lines stay LOG, a real failure is LOG!', lines(r13.out, 'LOG!').length === 1 && /1 failed/.test(lines(r13.out, 'LOG!')[0] ?? '') && lines(r13.out, 'LOG').length === 2, r13.out.split('\n').slice(1, 5).join(' | '));
const S7 = path.join(out, 'state7');
const r12 = run(['--state', S7, '--unit', `x=log:${path.join(out, 'no-such.log')}`, '--once']);
check('a log unit on a missing file says so in its footer', /\[x\] log missing: /.test(r12.out), r12.out.split('\n').slice(-1)[0]);

// A unit added over a transcript untouched for hours (a group paused yesterday): its last turn ended, so the
// footer is SAFE with the real end time, no STALL «for 498019h» from a zero timestamp, and its old flags stay
// out of BACKLOG.
const oldDir = path.join(out, 'projects-old');
fs.mkdirSync(oldDir, { recursive: true });
const SO = 'cccccccc-1111-2222-3333-444444444444';
const fO = path.join(oldDir, `${SO}.jsonl`);
clock = Date.now() - 30 * 3600e3;
write(fO, [U(SO, 'старая задача'), ...call(SO, 'o1', 'Bash', { command: 'pnpm lint --old' }, 'Exit code 2\nerror old', { err: true }), A(SO, [{ type: 'text', text: 'готово' }], { stop: 'end_turn' })]);
// An older conversation of the same unit whose Bash call never got its result (the turn was killed by a pause).
const SK = 'dddddddd-1111-2222-3333-444444444444';
const fK = path.join(oldDir, `${SK}.jsonl`);
clock = Date.now() - 96 * 3600e3;
write(fK, [U(SK, 'прерванная задача'), A(SK, [tool('k1', 'Bash', { command: 'git diff main..HEAD --stat' })])]);
const killedAt = new Date(clock);
fs.utimesSync(fK, killedAt, killedAt);
clock = Date.now() - 30 * 3600e3 + 10e3;
const oldAt = new Date(clock);
fs.utimesSync(fO, oldAt, oldAt);
const S8 = path.join(out, 'state8');
const r14 = run(['--state', S8, '--unit', `o=dir:${oldDir}`, '--once']);
const foot14 = r14.out.split('\n').find((l) => l.startsWith('[o]')) ?? '';
check('an hours-old ended transcript added fresh: no STALL', lines(r14.out, 'STALL').length === 0, lines(r14.out, 'STALL').join(' | '));
check('an hours-old ended transcript added fresh: footer SAFE with its real age', /SAFE ended (29|30)\.\d+h ago/.test(foot14) && /last (29|30)\.\d+h/.test(foot14), foot14);
check('an hours-old transcript keeps its old flags out of BACKLOG', lines(r14.out, 'ERR').length === 0, lines(r14.out, 'ERR').join(' | '));
check('a call left open in an hours-old transcript is not OPEN', lines(r14.out, 'OPEN').length === 0, lines(r14.out, 'OPEN').join(' | '));
// Dropping the only unit is saved, so adding it back seeds its tail again instead of keeping the old offsets.
const r15 = run(['--state', S8, '--drop', 'o', '--once']);
check('dropping the last unit exits 0 and says so', r15.code === 0 && /dropped o/.test(r15.out), `code ${r15.code}: ${r15.out.split('\n')[0]}`);
const kept = JSON.parse(fs.readFileSync(path.join(S8, 'watch-state.json'), 'utf8'));
check('dropping the last unit is saved in the state', !kept.units.o && !Object.values(kept.files).some((f) => f.unit === 'o'), Object.keys(kept.units).join(','));
// g1 26.10: paused mid-call, the host started a new conversation 74 min later → «OPEN running 74m» of the dead call.
const supDir = path.join(out, 'sup');
fs.mkdirSync(supDir, { recursive: true });
const SP = 'eeeeeeee-1111-2222-3333-444444444444';
const SN = 'ffffffff-1111-2222-3333-444444444444';
clock = Date.now() - 74 * 60e3;
write(path.join(supDir, `${SP}.jsonl`), [U(SP, 'прерванный разговор'), A(SP, [tool('p1', 'Bash', { command: 'pnpm old-conv-call' })])]);
fs.utimesSync(path.join(supDir, `${SP}.jsonl`), new Date(clock), new Date(clock));
clock = Date.now() - 5 * 60e3;
write(path.join(supDir, `${SN}.jsonl`), [U(SN, 'новый разговор'), A(SN, [tool('n1', 'Bash', { command: 'pnpm new-conv-call' })])]);
const r15b = run(['--state', path.join(out, 'state8b'), '--unit', `s=dir:${supDir}`, '--once']);
check('a call left open in a superseded conversation is not OPEN', !lines(r15b.out, 'OPEN').some((l) => l.includes('old-conv-call')), lines(r15b.out, 'OPEN').join(' | '));
check('a call open in the live conversation is still OPEN', lines(r15b.out, 'OPEN').some((l) => l.includes('new-conv-call')), lines(r15b.out, 'OPEN').join(' | ') || r15b.out.slice(0, 400));

// A sleep is a wait only where this shell or a runner it blocks on runs it (g3 25.10: a container's command paused a group).
const { sleepWaits } = await import('./lib/core.mjs');
const waits = ['sleep 5', 'cd x && sleep 5', 'for i in 1 2; do sleep 3; done', 'bash -c "sleep 5"', 'powershell -Command "Start-Sleep 5"', 'timeout 60 sleep 5', 'FOO=1 sleep 2', 'docker run --rm alpine sleep 5', 'docker exec "$CID" sleep 5', 'ssh host sleep 5', `node -e "execSync('sleep 5')"`, 'ping -n 5 127.0.0.1', 'sleep 0.5', 'sleep 05', 'sleep 0; sleep 3', 'Start-Sleep -Milliseconds 500', 'timeout /t 10'];
const idle = ['CID=$(docker create --label claude.ephemeral=1 -u 1000:1000 -e GOFLAGS=-mod=mod -w /src/app-config golang:1.25 sleep 600 2>&1 | tail -1); docker start "$CID"', 'docker run -d alpine sleep 600', 'docker run --detach alpine sleep 600', 'podman exec -d c sleep 9', 'sudo docker create img sleep 60', 'echo "sleep 5"', 'git log --grep "sleep 5"', 'sleep 0; node tests-cli.mjs delivery --project .', 'sleep 0s && x', 'powershell -Command "Start-Sleep -Seconds 0"', 'timeout /t 0', 'ping -n 1 127.0.0.1'];
for (const c of waits) check(`a wait: ${c}`, sleepWaits(c) === true);
for (const c of idle) check(`not a wait: ${c.slice(0, 60)}`, sleepWaits(c) === false);

// g1 26.10: a DENIED call carrying a probe loop + one 6-s vite probe = «sleep ×2» BURN, the group paused NOW. A denied
// call never ran and a loop probing a server breaks when it answers — neither burns; two real sleeps in a turn still do.
{
  const probe = 'for i in $(seq 1 60); do curl -sf -m5 http://localhost:5284/ >/dev/null && echo ready && break; sleep 1; done';
  const deny = { err: true, rec: { toolDenialKind: 'hook', permissionDecision: { decision: 'reject', source: 'hook' } } };
  const burnRun = (name, recs) => {
    const d = path.join(out, name);
    fs.mkdirSync(d, { recursive: true });
    const sid = `${name.padEnd(8, '0').slice(0, 8)}-1111-2222-3333-444444444444`;
    write(path.join(d, `${sid}.jsonl`), [U(sid, 'go'), ...recs(sid)]);
    return run(['--state', path.join(out, `${name}-state`), '--unit', `q=dir:${d}`, '--from', 'start', '--once']).out;
  };
  const oP = burnRun('burnprobe', (s) => [
    ...call(s, 'p1', 'Bash', { command: `node -e "fs.writeFileSync('c.json','{}')"; sleep 2; tail -3 a.log` }, 'PreToolUse:Bash hook error: [ctx-guard] inline-edit-guard: inline code writing a file', deny),
    ...call(s, 'p2', 'Bash', { command: `sleep 3; echo x` }, 'x'),
    ...call(s, 'p3', 'Bash', { command: `node a.mjs && ${probe}` }, 'ready'),
  ]);
  check('a denied sleep + one real sleep in a turn: no BURN', lines(oP, 'BURN').length === 0, lines(oP, 'BURN').join(' | '));
  check('a loop probing a server is no SLEEP', !lines(oP, 'SLEEP').some((l) => /node a\.mjs/.test(l)), lines(oP, 'SLEEP').join(' | '));
  const oB = burnRun('burnreal', (s) => [
    ...call(s, 'r1', 'Bash', { command: 'sleep 30; tail -3 run.log' }, 'x'),
    ...call(s, 'r2', 'Bash', { command: 'for i in $(seq 1 20); do grep -q EXIT .agent/tmp/gate.log && break; sleep 5; done' }, 'x'),
  ]);
  check('two real sleeps in a turn (one a loop over a gate log) still BURN', lines(oB, 'BURN').length === 1, lines(oB, 'BURN').join(' | ') || lines(oB, 'SLEEP').join(' | '));
}

// P10 (26.10 g8): a plugin's STAGE mark seen first, the conversation's own mark later for the same start → one mark.
{
  const { Watcher } = await import('./lib/core.mjs');
  const f = path.join(out, 'adopt.jsonl');
  const s = { units: { u: {} }, files: { [f]: { unit: 'u', role: 'main', offset: 900, bornLive: true, sid: 'abcdef1234', firstAt: 1000 } } };
  const w = new Watcher(s, {});
  w.convName = () => 'stage:review';
  w.mark('u', 'stage:review', { at: 3000 });
  w.convMark(s.files[f], 'brief', { f });
  const ms = s.marks.u;
  check('a conversation adopts the same-name stage mark the plugin made first: one mark, earlier time, its file from 0', ms.length === 1 && ms[0].conv === 'abcdef1234' && ms[0].at === 1000 && ms[0].off[f] === 0 && !(f in (ms[0].end ?? {})), JSON.stringify(ms));
  w.convMark({ ...s.files[f], sid: 'zzzz9999', firstAt: 1000 + 120e3 }, 'brief', { f });
  check('a same-name conversation minutes away is its own mark', s.marks.u.length === 2, JSON.stringify(s.marks.u.map((m) => [m.name, m.at])));
}

// F1/F15 (g9 26.10): a 9-hour gap replayed in one pass — refs keep their record time, an event stretch reads past the
// offsets the mark saw and cuts by record time, a file read past the event before this call has no start bound.
{
  const { Watcher } = await import('./lib/core.mjs');
  const fa = path.join(out, 'replay-a.jsonl');
  const fb = path.join(out, 'replay-b.jsonl');
  const at = (h) => Date.parse(`2026-10-26T0${h}:00:00Z`);
  const rec = (h, text) => JSON.stringify({ type: 'user', timestamp: new Date(at(h)).toISOString(), message: { role: 'user', content: text } });
  fs.writeFileSync(fa, [rec(1, 'A one'), rec(2, 'A two'), rec(4, 'A four'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'A untimed after' } })].join('\n') + '\n');
  fs.writeFileSync(fb, [rec(3, 'B three'), rec(5, 'B five')].join('\n') + '\n');
  const lenA1 = Buffer.byteLength(rec(1, 'A one') + '\n');
  const sizeA = fs.statSync(fa).size;
  const sizeB = fs.statSync(fb).size;
  // Catch-up: A sat at its first record when the marks were stamped; B was read past 03:00 before this call.
  const st = { units: { u: {} }, refs: {}, files: { [fa]: { unit: 'u', role: 'main', offset: lenA1, lastAt: at(1) }, [fb]: { unit: 'u', role: 'main', offset: sizeB, lastAt: at(5) } } };
  const w = new Watcher(st, {});
  w.emit('u', 'hi', 'GAP', 'replayed flag', at(2), null);
  check('a replayed flag keeps its record time in the ref ring', st.refs.u.ring.at(-1).at === at(2), JSON.stringify(st.refs.u.ring));
  w.mark('u', 'stage:a', { at: at(2) - 1 });
  w.mark('u', 'stage:b', { at: at(3) + 1 });
  const ma = st.marks.u[0];
  check('a file read past the event before this call has no start bound', ma.off[fb] === 0 && ma.off[fa] === lenA1, JSON.stringify(ma.off));
  st.files[fa].offset = sizeA;
  st.files[fa].lastAt = at(4);
  const S9 = path.join(out, 'state9');
  fs.mkdirSync(S9, { recursive: true });
  fs.writeFileSync(path.join(S9, 'watch-state.json'), JSON.stringify({ v: 1, ...st }));
  const p = spawnSync(process.execPath, [SHOW, '--state', S9, '--pack', 'u', '--from', 'stage:a', '--to', 'stage:b'], { encoding: 'utf8' }).stdout;
  check('an event stretch reads past the offset its end mark saw (A two)', /A two/.test(p), p);
  check('an event stretch cuts by record time (no A one, no A four, no untimed after)', !/A one|A four|A untimed/.test(p), p);
  check('a file read past the event before the call still gives its in-stretch records (B three)', /B three/.test(p) && !/B five/.test(p), p);
  const l = spawnSync(process.execPath, [SHOW, '--state', S9, '--list', 'u', '--from', 'stage:a', '--to', 'stage:b'], { encoding: 'utf8' }).stdout;
  const l2 = spawnSync(process.execPath, [SHOW, '--state', S9, '--list', 'u', '--from', 'stage:b'], { encoding: 'utf8' }).stdout;
  check('--list --from/--to keeps a stage’s flags by record time', /GAP replayed flag/.test(l) && !/GAP/.test(l2), `${l} | ${l2}`);
}

// W1 (g5 27.10): `--to` = the first mark of its name after `--from`, never the last one a day later; a window that
// crosses local midnight prints dates.
{
  const fw = path.join(out, 'w1-span.jsonl');
  const loc = (d, h, m) => new Date(2026, 9, d, h, m, 0).getTime();
  const rec = (t, text) => JSON.stringify({ type: 'user', timestamp: new Date(t).toISOString(), message: { role: 'user', content: text } });
  fs.writeFileSync(fw, [rec(loc(26, 0, 10), 'deliver tail'), rec(loc(26, 0, 30), 'after the first end'), rec(loc(27, 0, 40), 'recheck work')].join('\n') + '\n');
  const size = fs.statSync(fw).size;
  const mk = (name, t) => ({ name, at: t, off: { [fw]: 0 }, end: { [fw]: size }, ev: true });
  const ring = [
    { n: 1, f: null, tag: 'GAP', at: loc(26, 0, 12), text: 'deliver flag' },
    { n: 2, f: null, tag: 'GAP', at: loc(27, 0, 41), text: 'recheck flag' },
  ];
  const st = { v: 1, units: { u: {} }, refs: { u: { n: 2, ring } }, files: { [fw]: { unit: 'u', role: 'main', offset: size } } };
  st.marks = { u: [mk('stage:deliver', loc(26, 0, 6)), mk('ended', loc(26, 0, 23)), mk('stage:recheck', loc(27, 0, 36)), mk('ended', loc(27, 1, 29))] };
  const SW = path.join(out, 'state-w1');
  fs.mkdirSync(SW, { recursive: true });
  fs.writeFileSync(path.join(SW, 'watch-state.json'), JSON.stringify(st));
  const show = (...a) => spawnSync(process.execPath, [SHOW, '--state', SW, ...a], { encoding: 'utf8' });
  const p = show('--pack', 'u', '--from', 'stage:deliver', '--to', 'ended').stdout;
  check('W1: --to resolves to the first mark after --from (the delivery stretch only)', /deliver tail/.test(p) && !/after the first end|recheck work/.test(p), p);
  check('W1: a same-day window prints times only', /from stage:deliver \d\d:\d\d:\d\d to ended \d\d:\d\d:\d\d /.test(p), p.split('\n')[0]);
  const p2 = show('--pack', 'u', '--from', 'stage:recheck', '--to', 'ended').stdout;
  check('W1: --to after a later --from takes the later mark', /recheck work/.test(p2) && !/deliver tail/.test(p2), p2);
  const p3 = show('--pack', 'u', '--from', 'stage:deliver', '--to', 'stage:recheck').stdout;
  check('W1: a window crossing midnight prints dates in the header', /from stage:deliver 2026-10-26 00:06:00 to stage:recheck 2026-10-27 00:36:00 /.test(p3), p3.split('\n')[0]);
  const r4 = show('--pack', 'u', '--from', 'stage:recheck', '--to', 'stage:deliver');
  check('W1: a --to recorded only before --from is refused, naming both', r4.status === 2 && /--to stage:deliver after stage:recheck/.test(r4.stdout) && /2026-10-26 00:06:00/.test(r4.stdout), r4.stdout);
  const l = show('--list', 'u', '--from', 'stage:deliver', '--to', 'ended').stdout;
  check('W1: --list takes the same first-after pair', /deliver flag/.test(l) && !/recheck flag/.test(l), l);
  const m = show('--marks', 'u').stdout;
  check('W1: --marks spanning two days prints dates', /2026-10-26 00:23:00 ended/.test(m) && /2026-10-27 01:29:00 ended/.test(m), m);
  // A mark recorded after --from but stamped earlier (a stage backdated to its own start, before `setup`) still ends it.
  st.marks = { u: [mk('setup', loc(26, 0, 20)), mk('stage:review', loc(26, 0, 8))] };
  fs.writeFileSync(path.join(SW, 'watch-state.json'), JSON.stringify(st));
  const p5 = show('--pack', 'u', '--from', 'setup', '--to', 'stage:review');
  check('W1: --to = the first mark recorded after --from, even when stamped before it', p5.status === 0 && /to stage:review 00:08:00/.test(p5.stdout), p5.stdout);
}

// Two layers ship these scripts: a personal copy keeps its keepalive registry in <config>/cache/watchers, a kit copy
// (hooks/lib/kit-paths.mjs beside skills/) in the kit state dir — each read by its own Stop hook, never both.
{
  const where = await import(pathToFileURL(path.join(here, 'lib', 'where.mjs')).href);
  const ka = await import(pathToFileURL(path.join(here, 'lib', 'keepalive.mjs')).href);
  const plain = path.join(out, 'layer-personal');
  const kit = path.join(out, 'layer-kit');
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(path.join(kit, 'hooks', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'hooks', 'lib', 'kit-paths.mjs'), '');
  check('layer: a root without the kit path module is personal', where.kitRoot(plain) === null);
  check('layer: a root with hooks/lib/kit-paths.mjs is a kit', where.kitRoot(kit) === kit);
  check('layer: kit state = AGENTDECK_KIT_STATE, else <tmp>/agentdeck-kit-state', where.kitStateDir({ AGENTDECK_KIT_STATE: '/k' }) === '/k' && where.kitStateDir({}) === path.join(os.tmpdir(), 'agentdeck-kit-state'));
  const prev = process.env.AGENTDECK_KIT_STATE;
  process.env.AGENTDECK_KIT_STATE = path.join(out, 'kstate');
  check('layer: a personal copy registers in <config>/cache/watchers', ka.watchersDir('/cfg', null) === path.join('/cfg', 'cache', 'watchers'));
  check('layer: a kit copy registers in <kit state>/watchers', ka.watchersDir('/cfg', kit) === path.join(out, 'kstate', 'watchers'));
  if (prev === undefined) delete process.env.AGENTDECK_KIT_STATE;
  else process.env.AGENTDECK_KIT_STATE = prev;
}

// g1 26.10 audit F1: `tests-cli delivery` ×4 in one turn, only the evidence file edited between — CHECKER-LOOP once;
// the same check with a code edit between is a fix-and-verify cycle, never flagged.
{
  const dirL = path.join(out, 'projects-loop');
  fs.mkdirSync(dirL, { recursive: true });
  const SL = 'cccccccc-1111-2222-3333-444444444444';
  const ans = path.join(copy, '.agent', 'tmp', 'sieves-answer.md');
  const del = 'node tools/tests-cli.mjs delivery --project . --answer .agent/tmp/sieves-answer.md';
  clock = Date.now() - 10 * 60e3;
  write(path.join(dirL, `${SL}.jsonl`), [
    U(SL, 'Deliver'),
    ...call(SL, 'l1', 'Bash', { command: del }, 'Exit code 1\nsieve browser-focus: not backed by a run', { err: true }),
    ...call(SL, 'l2', 'Edit', { file_path: ans, old_string: 'a', new_string: 'run:4f5ba80b' }, 'ok'),
    ...call(SL, 'l3', 'Bash', { command: del }, 'Exit code 1\nsieve browser-focus: not backed by a run', { err: true }),
    ...call(SL, 'l4', 'Edit', { file_path: ans, old_string: 'b', new_string: 'run:53b69a2e' }, 'ok'),
    ...call(SL, 'l5', 'Bash', { command: del }, 'Exit code 1\nsieve browser-focus: not backed by a run', { err: true }),
    ...call(SL, 'l6', 'Bash', { command: del }, 'ok'),
    ...call(SL, 'l7', 'Bash', { command: 'pnpm test' }, 'Exit code 1\n1 failed', { err: true }),
    ...call(SL, 'l8', 'Edit', { file_path: fileX, old_string: 'b', new_string: 'c' }, 'ok'),
    ...call(SL, 'l9', 'Bash', { command: 'pnpm test' }, 'Exit code 1\n1 failed', { err: true }),
    ...call(SL, 'l10', 'Edit', { file_path: fileY, old_string: 'b', new_string: 'c' }, 'ok'),
    ...call(SL, 'l11', 'Bash', { command: 'pnpm test' }, 'all passed'),
    A(SL, [{ type: 'text', text: 'done' }], { stop: 'end_turn' }),
  ]);
  const rl = run(['--state', path.join(out, 'stateL'), '--unit', `l=dir:${dirL}`, '--from', 'start', '--once']);
  const loops = lines(rl.out, 'CHECKER-LOOP');
  check('CHECKER-LOOP: the same verdict ×3 in one turn with only the evidence file edited between, flagged once', loops.length === 1 && /tests-cli\.mjs delivery .* ×3 in one turn, edits between only to \.agent\/tmp\/sieves-answer\.md/.test(loops[0]), rl.out);
  check('CHECKER-LOOP: a check rerun after code edits (fix-and-verify) is not flagged', !loops.some((l) => /pnpm test/.test(l)), loops.join(' | '));
}

if (!argv.includes('--keep')) fs.rmSync(out, { recursive: true, force: true });
else console.log(`fixture kept: ${out}`);
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `\n${fails.map((f) => `  - ${f}`).join('\n')}` : ''}`);
process.exitCode = fails.length ? 1 : 0;
