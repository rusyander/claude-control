#!/usr/bin/env node
// Self-test of the foreign-CLI mappers (lib/foreign.mjs) through the real entry point: watch.mjs as a child process
// over a throwaway home where every mapped CLI (codex, qwen, gemini, continue, opencode) left one invented session of
// the same script — a failing check, the same command twice, a refused push, a read, a final answer. Units are
// registered the way the agentdeck plugin will: a pre-written watch-state.json with kind:'foreign' units (core's
// discover → foreignFiles), then `watch.mjs --state <tmp> --once --from start --config-root <tmp>`.
// Per provider it asserts: the shell call is named Bash, ERR on the non-zero exit, REPEAT on the twin command, DENY on
// the refusal, END on the answer, the footer's spent line to the token; a second turn appended feeds ONLY its own
// records (no second END of turn 1, spent counts one message); show.mjs opens a whole-document ref; a decoy session
// of another directory is never read; an unmapped CLI stays status-only. Nothing outside the temp dir is touched:
// the child's HOME/USERPROFILE point into it and every CLI home env var is cleared.
//   node selftest-foreign.mjs [--keep]        exit 0 = all green, 1 = a check failed
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(here, 'watch.mjs');
const SHOW = path.join(here, 'show.mjs');
const keep = process.argv.includes('--keep');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-foreign-'));
const home = path.join(out, 'home');
const config = path.join(out, 'config');
const state = path.join(out, 'state');
const codexHome = path.join(out, 'codex-home'); // CODEX_HOME honoured
const PROVIDERS = ['codex', 'qwen', 'gemini', 'continue', 'opencode'];
const copyOf = (p) => path.join(out, 'copies', p);
const decoy = path.join(out, 'copies', 'elsewhere');
for (const d of [home, config, state, decoy, ...PROVIDERS.map(copyOf)]) fs.mkdirSync(d, { recursive: true });

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
for (const k of ['QWEN_HOME', 'GEMINI_CLI_HOME', 'CONTINUE_GLOBAL_DIR', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
const node = (args) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, env });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status };
};
const watch = () => node([WATCH, '--state', state, '--once', '--from', 'start', '--config-root', config, '--no-keepalive', '--budget', '200000']);
const flags = (o, unit, tag) => o.split('\n').filter((l) => new RegExp(`^\\d\\d:\\d\\d:\\d\\d ${unit} ${tag.replace(/[+!]/g, '\\$&')} `).test(l));
const footer = (o, unit) => o.split('\n').find((l) => l.startsWith(`[${unit}] `)) ?? '';

// ---- the script every CLI plays (invented content) ----
const P1 = 'Implement feature F in the copy';
const P2 = 'Second task: tidy the notes';
const TURN1 = (copy) => [
  { kind: 'tool', id: 'c1', cmd: 'pnpm lint', exit: 1, out: 'src/a.ts:3 lint rule no-bad-type violated' },
  { kind: 'tool', id: 'c2', cmd: 'git log --oneline -3', exit: 0, out: 'abc one' },
  { kind: 'tool', id: 'c3', cmd: 'git log --oneline -3', exit: 0, out: 'abc one' },
  { kind: 'tool', id: 'c4', cmd: 'git push --force origin x', deny: true },
  { kind: 'read', id: 'c5', file: path.join(copy, 'src', 'x.ts'), out: '1 const a = 1' },
  { kind: 'text', text: 'Done: feature F implemented and checked.' },
];
const TURN2 = () => [{ kind: 'text', text: 'Second answer done.' }];
// Every reply bills 12000 prompt tokens of which 8000 cached, 100 out → write 4000, read 8000 per message.
const IN = 12000;
const CACHED = 8000;
const OUT = 100;
let clock = Date.now() - 30 * 60e3;
const tick = () => (clock += 1000);
const ts = () => new Date(tick()).toISOString();
const write = (f, recs, append = true) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const writeDoc = (f, doc) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(doc, null, 2));
};

// ---- codex: rollout JSONL ----
let resp = 0;
function codexTurn(prompt, steps) {
  const L = [
    { timestamp: ts(), type: 'turn_context', payload: { model: 'gpt-test' } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'task_started', turn_id: `t${resp}` } },
    { timestamp: ts(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } },
  ];
  const usage = () => ({ timestamp: ts(), type: 'token_usage_record', payload: { response_id: `resp_${++resp}`, usage: { input_tokens: IN, cached_input_tokens: CACHED, cache_write_input_tokens: 0, output_tokens: OUT } } });
  let last = '';
  for (const s of steps) {
    if (s.kind === 'text') {
      L.push({ timestamp: ts(), type: 'response_item', payload: { type: 'message', id: `msg_${resp + 1}`, role: 'assistant', content: [{ type: 'output_text', text: s.text }] } }, usage());
      last = s.text;
      continue;
    }
    const args = s.kind === 'read' ? { file_path: s.file } : { cmd: s.cmd };
    L.push({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call', id: `fc_${s.id}`, name: s.kind === 'read' ? 'read_file' : 'exec_command', arguments: JSON.stringify(args), call_id: s.id } }, usage());
    // The repeated token_count of every reply must not be billed twice.
    L.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: resp * (IN + OUT) }, last_token_usage: { input_tokens: IN, cached_input_tokens: CACHED, output_tokens: OUT } } } });
    const output = s.deny ? 'exec command rejected by user' : s.kind === 'read' ? s.out : `Chunk ID: 1a\nWall time: 0.1 seconds\nProcess exited with code ${s.exit}\nOriginal token count: 3\nOutput:\n${s.out}\n`;
    L.push({ timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', call_id: s.id, output } });
  }
  L.push({ timestamp: ts(), type: 'event_msg', payload: { type: 'task_complete', turn_id: `t${resp}`, last_agent_message: last } });
  return L;
}
const day = new Date().toISOString().slice(0, 10).split('-');
const codexDir = path.join(codexHome, 'sessions', ...day);
const codexFile = path.join(codexDir, 'rollout-2026-10-25T01-00-00-0a0a0a0a-1111-2222-3333-444444444444.jsonl');
const meta = (cwd, id) => ({ timestamp: ts(), type: 'session_meta', payload: { id, cwd, cli_version: '0.155.1', base_instructions: { text: 'x'.repeat(70000) } } });
write(codexFile, [meta(copyOf('codex'), '0a0a0a0a-1111-2222-3333-444444444444'), ...codexTurn(P1, TURN1(copyOf('codex')))]);
write(path.join(codexDir, 'rollout-2026-10-25T01-00-01-0b0b0b0b-1111-2222-3333-444444444444.jsonl'), [meta(decoy, '0b0b0b0b-1111-2222-3333-444444444444'), ...codexTurn('DECOY prompt', [{ kind: 'text', text: 'DECOY answer' }])]);

// ---- qwen: projects/<slug>/chats/<sid>.jsonl in the kit's qwen home ----
const qslug = (abs) => (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/[^a-zA-Z0-9]/g, '-');
const qwenChats = (cwd) => path.join(config, 'agentdeck', 'kit', 'qwen-home', 'projects', qslug(path.resolve(cwd)), 'chats');
let qr = 0;
function qwenTurn(prompt, steps) {
  const L = [{ timestamp: ts(), type: 'user', provenance: 'real_user', message: { role: 'user', parts: [{ text: prompt }] } }];
  const tel = () => ({ timestamp: ts(), type: 'system', provenance: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', response_id: `r${++qr}`, model: 'qwen-test', input_token_count: IN, cached_content_token_count: CACHED, output_token_count: OUT, thoughts_token_count: 0 } } });
  const um = { promptTokenCount: IN, cachedContentTokenCount: CACHED, candidatesTokenCount: OUT };
  for (const s of steps) {
    L.push(tel());
    if (s.kind === 'text') {
      L.push({ timestamp: ts(), type: 'assistant', model: 'qwen-test', message: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: s.text }] }, usageMetadata: um });
      continue;
    }
    const name = s.kind === 'read' ? 'read_file' : 'run_shell_command';
    const args = s.kind === 'read' ? { absolute_path: s.file } : { command: s.cmd, description: 'step' };
    L.push({ timestamp: ts(), type: 'assistant', model: 'qwen-test', message: { role: 'model', parts: [{ functionCall: { id: s.id, name, args } }] }, usageMetadata: um });
    const output = s.kind === 'read' ? s.out : `Command: ${s.cmd}\nDirectory: (root)\nOutput: ${s.out}\nError: (none)\nExit Code: ${s.exit}`;
    const response = s.deny ? { error: 'User did not allow tool call' } : { output };
    L.push({ timestamp: ts(), type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: s.id, name, response } }] }, toolCallResult: { callId: s.id, status: s.deny ? 'cancelled' : 'success', resultDisplay: s.kind === 'tool' && !s.deny ? { type: 'shell_result', exitCode: s.exit } : '' } });
  }
  return L;
}
const qwenFile = path.join(qwenChats(copyOf('qwen')), 'aaaa1111-2222-3333-4444-555555555555.jsonl');
write(qwenFile, qwenTurn(P1, TURN1(copyOf('qwen'))));
write(path.join(qwenChats(copyOf('qwen')), 'aaaa1111-2222-3333-4444-555555555555.ledger.jsonl'), [{ type: 'assistant', message: { parts: [{ text: 'DECOY ledger' }] } }]);
write(path.join(qwenChats(decoy), 'bbbb1111-2222-3333-4444-555555555555.jsonl'), qwenTurn('DECOY prompt', [{ kind: 'text', text: 'DECOY answer' }]));

// ---- gemini: ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.json (whole document) ----
const gemDir = (cwd) => path.join(home, '.gemini', 'tmp', crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex'), 'chats');
let gm = 0;
function gemTurn(prompt, steps) {
  const M = [{ id: `g${++gm}`, timestamp: ts(), type: 'user', content: prompt }];
  const tokens = { input: IN, cached: CACHED, output: OUT, thoughts: 0, tool: 0, total: IN + OUT };
  for (const s of steps) {
    if (s.kind === 'text') {
      M.push({ id: `g${++gm}`, timestamp: ts(), type: 'gemini', content: s.text, model: 'gemini-test', tokens });
      continue;
    }
    const name = s.kind === 'read' ? 'read_file' : 'run_shell_command';
    const args = s.kind === 'read' ? { absolute_path: s.file } : { command: s.cmd };
    const output = s.kind === 'read' ? s.out : `Command: ${s.cmd}\nOutput: ${s.out}\nExit Code: ${s.exit}`;
    const status = s.deny ? 'cancelled' : 'success';
    const result = [{ functionResponse: { id: s.id, name, response: s.deny ? { error: 'Tool call cancelled by user' } : { output } } }];
    M.push({ id: `g${++gm}`, timestamp: ts(), type: 'gemini', content: '', model: 'gemini-test', tokens, toolCalls: [{ id: s.id, name, args, result, status, timestamp: ts() }] });
  }
  return M;
}
const gemFile = path.join(gemDir(copyOf('gemini')), 'session-2026-10-25T01-00-abcd1234.json');
const gemMsgs = gemTurn(P1, TURN1(copyOf('gemini')));
writeDoc(gemFile, { sessionId: 'abcd1234', projectHash: 'h', startTime: ts(), lastUpdated: ts(), messages: gemMsgs });
writeDoc(path.join(gemDir(decoy), 'session-2026-10-25T01-00-dddd0000.json'), { sessionId: 'dddd0000', messages: gemTurn('DECOY prompt', [{ kind: 'text', text: 'DECOY answer' }]) });

// ---- continue: ~/.continue/sessions/<sid>.json (whole document, no timestamps) ----
function contTurn(prompt, steps) {
  const H = [{ message: { role: 'user', content: prompt }, contextItems: [] }];
  const usage = { prompt_tokens: IN, completion_tokens: OUT, total_tokens: IN + OUT, prompt_tokens_details: { cached_tokens: CACHED } };
  for (const s of steps) {
    if (s.kind === 'text') {
      H.push({ message: { role: 'assistant', content: s.text, usage }, contextItems: [] });
      continue;
    }
    const name = s.kind === 'read' ? 'Read' : 'Bash';
    const args = s.kind === 'read' ? { filepath: s.file } : { command: s.cmd };
    const status = s.deny ? 'canceled' : s.exit ? 'errored' : 'done';
    const content = s.deny ? 'Permission denied by user' : s.exit ? `Error (exit code ${s.exit}): ${s.out}` : s.out;
    const call = { id: s.id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    H.push({ message: { role: 'assistant', content: '', toolCalls: [call], usage }, contextItems: [], toolCallStates: [{ toolCallId: s.id, toolCall: call, status, parsedArgs: args, output: [{ content, name: 'Tool Result', description: 'Tool execution result' }] }] });
  }
  return H;
}
const contDir = path.join(home, '.continue', 'sessions');
const contFile = path.join(contDir, 'cccc1111-2222-3333-4444-555555555555.json');
const contHist = contTurn(P1, TURN1(copyOf('continue')));
writeDoc(contFile, { sessionId: 'cccc1111', title: 't', workspaceDirectory: copyOf('continue'), history: contHist });
writeDoc(path.join(contDir, 'dddd1111-2222-3333-4444-555555555555.json'), { sessionId: 'dddd1111', title: 't', workspaceDirectory: decoy, history: contTurn('DECOY prompt', [{ kind: 'text', text: 'DECOY answer' }]) });
writeDoc(path.join(contDir, 'sessions.json'), [{ sessionId: 'cccc1111', workspaceDirectory: copyOf('continue') }]);
// A document that grows from one record to many between two reads: the new records outnumber the fed ones, so a
// ledger that stopped padding would lose the head of the new stretch.
const growCopy = path.join(out, 'copies', 'grow');
fs.mkdirSync(growCopy, { recursive: true });
const growFile = path.join(contDir, 'eeee1111-2222-3333-4444-555555555555.json');
const growHist = contTurn(P1, TURN1(growCopy));
writeDoc(growFile, { sessionId: 'eeee1111', title: 't', workspaceDirectory: growCopy, history: growHist.slice(0, 1) });

// ---- opencode: ~/.local/share/opencode/opencode.db (sqlite; the watch exports it read-only) ----
const ocDb = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
fs.mkdirSync(path.dirname(ocDb), { recursive: true });
const warn = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
process.emitWarning = warn;
const db = new DatabaseSync(ocDb);
db.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, time_updated integer NOT NULL)');
db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)');
db.exec('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)');
let on = 0;
const nid = (p) => `${p}_${String(++on).padStart(4, '0')}`;
function ocTurn(sid, prompt, steps) {
  const addMsg = (data) => {
    const id = nid('msg');
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, sid, tick(), JSON.stringify(data));
    return id;
  };
  const addPart = (mid, data) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(nid('prt'), mid, sid, tick(), JSON.stringify(data));
  const u = addMsg({ role: 'user', time: { created: clock } });
  addPart(u, { type: 'text', text: prompt });
  const tokens = { input: IN - CACHED, output: OUT, reasoning: 0, cache: { read: CACHED, write: 0 } };
  for (const s of steps) {
    const t0 = tick();
    const m = addMsg({ role: 'assistant', modelID: 'oc-test', providerID: 'stub', time: { created: t0, completed: t0 + 500 }, finish: s.kind === 'text' ? 'stop' : 'tool-calls', tokens });
    addPart(m, { type: 'step-start' });
    if (s.kind === 'text') addPart(m, { type: 'text', text: s.text, time: { start: t0, end: t0 + 400 } });
    else {
      const input = s.kind === 'read' ? { filePath: s.file } : { command: s.cmd, description: 'step' };
      const st = s.deny
        ? { status: 'error', input, error: 'The user rejected permission to use this specific tool call.', time: { start: t0, end: t0 + 100 } }
        : { status: 'completed', input, output: s.out, metadata: s.kind === 'tool' ? { exit: s.exit, output: s.out } : {}, time: { start: t0, end: t0 + 100 } };
      addPart(m, { type: 'tool', callID: s.id, tool: s.kind === 'read' ? 'read' : 'bash', state: st });
    }
    addPart(m, { type: 'step-finish', tokens, cost: 0 });
  }
  db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(clock, sid);
}
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_main', null, copyOf('opencode'), clock);
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_decoy', null, decoy, clock);
ocTurn('ses_main', P1, TURN1(copyOf('opencode')));
ocTurn('ses_decoy', 'DECOY prompt', [{ kind: 'text', text: 'DECOY answer' }]);

// ---- units: kind 'foreign', as the agentdeck plugin registers a group of another CLI ----
const units = {};
for (const [i, p] of [...PROVIDERS, 'goose'].entries()) units[p] = { kind: 'foreign', target: `group-${p}`, copy: p === 'goose' ? decoy : copyOf(p), group: { provider: p, parent: 'selftest', index: i + 1 }, addedAt: Date.now() };
units.grow = { kind: 'foreign', target: 'group-grow', copy: growCopy, group: { provider: 'continue', parent: 'selftest', index: 9 }, addedAt: Date.now() };
fs.writeFileSync(path.join(state, 'watch-state.json'), JSON.stringify({ v: 1, units, files: {}, refs: {}, unknown: {}, plugin: {} }));

// ---- run 1: the whole first turn of every CLI ----
const r1 = watch();
check('run 1 exits 0', r1.code === 0, r1.out.slice(0, 400));
for (const p of PROVIDERS) {
  check(`${p}: shell call named Bash`, flags(r1.out, p, 'CALL').some((l) => l.includes("CALL Bash 'pnpm lint'")), flags(r1.out, p, 'CALL').join(' | ').slice(0, 300));
  check(`${p}: ERR on exit 1`, flags(r1.out, p, 'ERR').some((l) => /ERR Bash 'pnpm lint': exit 1: /.test(l)), flags(r1.out, p, 'ERR').join(' | '));
  check(`${p}: no ERR beyond the failing check`, flags(r1.out, p, 'ERR').length === 1, flags(r1.out, p, 'ERR').join(' | '));
  check(`${p}: REPEAT on the twin command`, flags(r1.out, p, 'REPEAT').some((l) => l.includes("×2 'git log --oneline -3'")), flags(r1.out, p, 'REPEAT').join(' | '));
  check(`${p}: DENY on the refused push`, flags(r1.out, p, 'DENY').some((l) => l.includes("Bash 'git push --force origin x'")), flags(r1.out, p, 'DENY').join(' | '));
  check(`${p}: Read named Read`, flags(r1.out, p, 'CALL').some((l) => /CALL Read src\/x\.ts\b/.test(l)), flags(r1.out, p, 'CALL').join(' | ').slice(0, 300));
  const ends = flags(r1.out, p, 'END');
  check(`${p}: one END with the answer`, ends.length === 1 && ends[0].includes('Done: feature F implemented and checked.'), ends.join(' | '));
  check(`${p}: NEWCONV on the first prompt`, flags(r1.out, p, 'NEWCONV').some((l) => l.includes(P1)), flags(r1.out, p, 'NEWCONV').join(' | '));
  const f = footer(r1.out, p);
  check(`${p}: footer SAFE, spent to the token`, /SAFE/.test(f) && f.includes('· ctx 12k ·') && f.includes('spent 6 msg out 600 write 24k read 48k'), f);
}
check('decoy sessions never read', !/DECOY/.test(r1.out), r1.out.split('\n').filter((l) => /DECOY/.test(l)).join(' | '));
check('unmapped CLI stays status-only', /^\[goose\] no transcript yet/m.test(r1.out), footer(r1.out, 'goose'));
check('no PARSE / UNKNOWN', !/ (?:PARSE|UNKNOWN) /.test(r1.out), r1.out.split('\n').filter((l) => / (?:PARSE|UNKNOWN) /.test(l)).join(' | '));
check('opencode export lives in the state dir', fs.existsSync(path.join(state, 'foreign', 'opencode-ses_main.json')) && !fs.existsSync(path.join(state, 'foreign', 'opencode-ses_decoy.json')));

// ---- show.mjs opens a whole-document ref (no byte range) ----
for (const p of ['continue', 'opencode', 'gemini']) {
  const ref = /#[\w-]+:\d+/.exec(flags(r1.out, p, 'END')[0] ?? '')?.[0];
  const s = ref ? node([SHOW, '--state', state, ref]) : { out: '' };
  check(`${p}: show.mjs opens the END ref`, !!ref && s.out.includes('Done: feature F implemented and checked.'), s.out.slice(0, 300));
}

// ---- run 2: a second turn appended — only its own records are fed ----
write(codexFile, codexTurn(P2, TURN2()));
write(qwenFile, qwenTurn(P2, TURN2()));
const gemMsgs2 = gemTurn(P2, TURN2());
writeDoc(gemFile, { sessionId: 'abcd1234', projectHash: 'h', startTime: ts(), lastUpdated: ts(), messages: [...gemMsgs, ...gemMsgs2] });
writeDoc(contFile, { sessionId: 'cccc1111', title: 't', workspaceDirectory: copyOf('continue'), history: [...contHist, ...contTurn(P2, TURN2())] });
ocTurn('ses_main', P2, TURN2());
db.close();
check('grow: run 1 saw only the prompt', flags(r1.out, 'grow', 'NEWCONV').length === 1 && !flags(r1.out, 'grow', '(?:ERR|END)').length, flags(r1.out, 'grow', '\\S+').join(' | '));
writeDoc(growFile, { sessionId: 'eeee1111', title: 't', workspaceDirectory: growCopy, history: growHist });
const r2 = watch();
check('run 2 exits 0', r2.code === 0, r2.out.slice(0, 400));
check('grow: run 2 fed the whole new stretch', flags(r2.out, 'grow', 'ERR').some((l) => /ERR Bash 'pnpm lint': exit 1: /.test(l)) && flags(r2.out, 'grow', 'REPEAT').length === 1 && flags(r2.out, 'grow', 'DENY').length === 1 && flags(r2.out, 'grow', 'END').length === 1 && footer(r2.out, 'grow').includes('spent 6 msg'), flags(r2.out, 'grow', '\\S+').join(' | '));
for (const p of PROVIDERS) {
  const ends = flags(r2.out, p, 'END');
  check(`${p}: run 2 one END, the new answer only`, ends.length === 1 && ends[0].includes('Second answer done.'), ends.join(' | '));
  check(`${p}: run 2 no old flag re-fed`, !flags(r2.out, p, '(?:ERR|REPEAT|DENY|NEWCONV)').length, flags(r2.out, p, '(?:ERR|REPEAT|DENY|NEWCONV)').join(' | '));
  check(`${p}: run 2 INJECT on the second prompt`, flags(r2.out, p, 'INJECT').some((l) => l.includes(P2)), flags(r2.out, p, 'INJECT').join(' | '));
  check(`${p}: run 2 spent one message`, footer(r2.out, p).includes('spent 1 msg out 100 write 4k read 8k'), footer(r2.out, p));
}
check('run 2 decoy still unread', !/DECOY/.test(r2.out));
// readRef by the file's ledger (the exact path show.mjs takes once it passes st.fx.keys): the run-2 END of each whole
// format opens its own record, and a key list that does not hold the index opens nothing rather than a neighbour.
{
  const { readRef } = await import(new URL('./lib/foreign.mjs', import.meta.url).href);
  const S = JSON.parse(fs.readFileSync(path.join(state, 'watch-state.json'), 'utf8'));
  for (const p of ['continue', 'opencode', 'gemini']) {
    const ref = /#([\w-]+):(\d+)/.exec(flags(r2.out, p, 'END')[0] ?? '');
    const x = ref && S.refs[ref[1]]?.ring.find((y) => y.n === Number(ref[2]));
    const fx = x ? S.files[x.f]?.fx : null;
    const got = x ? readRef({ f: x.f, idx: x.idx, fmt: p, keys: fx?.keys, drop: fx?.drop }) : null;
    check(`${p}: readRef by ledger key opens the run-2 END`, !!got && got.includes('Second answer done.') && x.idx > 10, String(got).slice(0, 200));
    check(`${p}: readRef with a stale ledger opens nothing`, x && readRef({ f: x.f, idx: x.idx, fmt: p, keys: [] }) === null);
  }
}

// ---- run 3: nothing of the watched sessions moved — nothing fed, the opencode export is not rewritten even though
// the db itself moved (another directory's session wrote to it) ----
const exp = path.join(state, 'foreign', 'opencode-ses_main.json');
const mt = fs.statSync(exp).mtimeMs;
const db2 = new DatabaseSync(ocDb);
db2.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_zzzz', 'msg_none', 'ses_decoy', tick(), JSON.stringify({ type: 'text', text: 'DECOY late part' }));
db2.close();
const r3 = watch();
check('run 3 quiet: no flag, spent 0 everywhere', !/ (?:END|ERR|REPEAT|DENY|INJECT|NEWCONV) /.test(r3.out) && PROVIDERS.every((p) => footer(r3.out, p).includes('spent 0')), r3.out.slice(0, 600));
check('run 3 opencode export untouched', fs.statSync(exp).mtimeMs === mt);

// show.mjs itself passes the ledger to readRef: a record put in front of the gemini document shifts every position,
// so only a lookup by key still opens the run-2 END (a positional one opens its neighbour).
{
  const ref = /#[\w-]+:\d+/.exec(flags(r2.out, 'gemini', 'END')[0] ?? '')?.[0];
  writeDoc(gemFile, { sessionId: 'abcd1234', projectHash: 'h', startTime: ts(), lastUpdated: ts(), messages: [{ id: 'g-pre', timestamp: ts(), type: 'user', content: 'An older prompt restored in front.' }, ...gemMsgs, ...gemMsgs2] });
  const s = ref ? node([SHOW, '--state', state, ref]) : { out: '' };
  check('gemini: show.mjs opens the run-2 END by ledger key after a shift', !!ref && s.out.includes('Second answer done.'), s.out.slice(0, 300));
}

console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `: ${fails.join('; ')}` : ''}`);
if (keep) console.log(`kept ${out}`);
else fs.rmSync(out, { recursive: true, force: true });
process.exitCode = fails.length ? 1 : 0;
