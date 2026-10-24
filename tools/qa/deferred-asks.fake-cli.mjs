// Фальшивый `claude` для `check-group-deferred-asks.mjs` — отдельным модулем,
// чтобы сама проверка читалась сценариями, а не текстом подменного CLI.

/**
 * Фальшивый `claude`: протокол потокового ввода, транскрипт, права через мост.
 * Ход `SCENARIO:ASK` — один вызов человеку, затем две попытки ответить за него;
 * ход с номером D-n (продолжение после решения) или `SCENARIO:AGAIN` — тот же
 * вызов дважды и чуть другой. Ничьих решений сам не принимает: всё, что он
 * узнал, пишет строкой в `results.jsonl`.
 */
export const FAKE_CLI = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('--input-format')) {
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
const ALIVE = join(dirname(process.argv[1]), '.stand-alive');
setInterval(() => { if (!existsSync(ALIVE)) process.exit(0); }, 1000).unref();
// Каталог записей — рядом с каталогом обёртки: путь стенда известен только ему.
const STATE = join(dirname(process.argv[1]), '..', 'fake-state');
const HUMAN_CMD = process.env.FAKE_HUMAN_CMD;
const OTHER_CMD = process.env.FAKE_OTHER_CMD;
const unq = (value) => (value === undefined ? undefined : value.replace(/^"|"$/g, ''));
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? unq(argv[at + 1]) : undefined;
};
const session = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const cwd = process.cwd();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, session + '.jsonl');
let parentUuid = null;
function record(type, message) {
  const uuid = randomUUID();
  appendFileSync(transcript, JSON.stringify({ parentUuid, uuid, type, message, sessionId: session, cwd,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', version: '2.1.999' }) + '\n');
  parentUuid = uuid;
}
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const note = (entry) => appendFileSync(join(STATE, 'results.jsonl'), JSON.stringify({ session, at: Date.now(), ...entry }) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mcp;
let baseUrl = '';
let nextId = 1;
const waiting = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => waiting.set(id, resolve));
}
const mcpFile = flag('--mcp-config');
if (mcpFile) {
  const guard = JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers?.['perm-guard'];
  if (guard) {
    baseUrl = guard.env?.PERM_BASE_URL ?? '';
    mcp = spawn(guard.command, guard.args, { env: { ...process.env, ...guard.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    });
    void rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  }
}
/** Вопрос мосту; не ответил за ms — «ждёт» (карточка у человека), а не «разрешено». */
async function approve(input, toolUseId, ms = 0) {
  if (!mcp) return { behavior: 'none' };
  const call = rpc('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input, tool_use_id: toolUseId } })
    .then((reply) => JSON.parse(reply.result?.content?.[0]?.text ?? '{}'));
  if (!ms) return await call;
  return await Promise.race([call, sleep(ms).then(() => ({ behavior: 'pending' }))]);
}

const msgId = () => 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);
function assistant(content) {
  const message = { id: msgId(), type: 'message', role: 'assistant', model: 'fake-deferred', content,
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
  out({ type: 'assistant', message, session_id: session });
  record('assistant', message);
}
function toolResult(id, decision) {
  const allowed = decision.behavior === 'allow';
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
    content: allowed ? 'published' : String(decision.message ?? decision.behavior), is_error: !allowed }] };
  out({ type: 'user', message, session_id: session });
  record('user', message);
}
function finish(text) {
  assistant([{ type: 'text', text }]);
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001, duration_ms: 1, num_turns: 1,
    result: text, session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });
}
async function call(command, id, ms) {
  const input = { command, description: 'Publish the package' };
  assistant([{ type: 'tool_use', id, name: 'Bash', input }]);
  const decision = await approve(input, id, ms);
  if (decision.behavior !== 'pending') toolResult(id, decision);
  return decision;
}

let turn = 0;
async function runTurn(content) {
  turn += 1;
  record('user', { role: 'user', content });
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake-deferred', tools: [], cwd });
  if (content.includes('SCENARIO:ASK')) {
    const asked = await call(HUMAN_CMD, 'toolu_ask_' + turn, 0);
    const id = /agentdeck\(deferred (D-\d+)\)/.exec(String(asked.message ?? ''))?.[1];
    note({ step: 'ask', behavior: asked.behavior, id, message: String(asked.message ?? '').slice(0, 300) });
    if (id) {
      // Ответить за человека изнутри прогона: прямым запросом к маршруту…
      let status = 0;
      try {
        const res = await fetch(baseUrl + '/api/chat/deferred/' + id + '/decision', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow', via: 'web' }) });
        status = res.status;
      } catch { status = -1; }
      note({ step: 'self-fetch', status });
      // …и вызовом инструмента, который до него тянется.
      const curl = await call("curl -s -X POST " + baseUrl + "/api/chat/deferred/" + id + "/decision -H 'content-type: application/json' -d '{\"behavior\":\"allow\"}'", 'toolu_self_' + turn, 8000);
      note({ step: 'self-bridge', behavior: curl.behavior, message: String(curl.message ?? '').slice(0, 200) });
    }
    finish('AFTER-DEFER-OK\nWaiting for the human: ' + (id ?? 'none') + ' — publish the package');
    note({ step: 'end' });
    return;
  }
  if (content.includes('SCENARIO:AGAIN') || /\bD-\d+\b/.test(content)) {
    note({ step: 'again-turn', prompt: content.slice(0, 160) });
    const first = await call(HUMAN_CMD, 'toolu_exact1_' + turn, 8000);
    note({ step: 'exact1', behavior: first.behavior });
    const second = await call(HUMAN_CMD, 'toolu_exact2_' + turn, 5000);
    note({ step: 'exact2', behavior: second.behavior, message: String(second.message ?? '').slice(0, 160) });
    const other = await call(OTHER_CMD, 'toolu_other_' + turn, 5000);
    note({ step: 'other', behavior: other.behavior, message: String(other.message ?? '').slice(0, 160) });
    finish('AGAIN-DONE');
    return;
  }
  // Любой другой ход (продолжение конвейера, вводная) — без вызовов.
  note({ step: 'plain-turn', prompt: content.slice(0, 160) });
  finish('PLAIN-OK');
}

const queue = [];
let busy = false;
let stdinEnded = false;
async function pump() {
  if (busy) return;
  const next = queue.shift();
  if (next === undefined) {
    if (stdinEnded) { mcp?.kill(); process.exit(0); }
    return;
  }
  busy = true;
  try { await runTurn(next); } finally { busy = false; }
  void pump();
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type !== 'user') return;
    const content = message.message?.content;
    queue.push(typeof content === 'string' ? content : JSON.stringify(content));
    void pump();
  })
  .on('close', () => { stdinEnded = true; void pump(); });
`;
