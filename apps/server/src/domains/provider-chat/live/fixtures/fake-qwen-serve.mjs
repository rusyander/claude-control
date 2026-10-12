// Подделка `qwen serve` для тестов живого хода: те пути и события, что сняты с
// настоящего CLI 0.25.0. Режим — FAKE_MODE: `inject` (сообщение посреди хода
// встаёт в тот же ход), `pending` (ход успевает кончиться — сообщение начинает
// следующий запрос той же сессии, ответ на него идёт ANSWER_MS), `permission`
// (инструмент просит разрешения), `no-server` (подкоманды нет), `mcp` (сервер MCP
// поднимается MCP_MS, как у настоящего 0.25, фоном после ответа на POST /session:
// промпт, пришедший раньше, его инструментов не видит; ход дописывает, видел ли),
// `fail` (ход кончается `turn_error`).
// С FAKE_STORE сессии живут на «диске» (`fake-session-store.mjs`): `POST
// /session/:id/resume` поднимает записанную, и поток событий такой сессии сперва
// проигрывает события её прежних ходов (с их promptId) — ответом хода они не
// являются. `DELETE /session/:id` закрывает, `POST /sessions/delete` стирает.
import { createServer } from 'node:http';
import { change, load, nextId, persistent, remove } from './fake-session-store.mjs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const mode = process.env.FAKE_MODE ?? 'inject';
const holdMs = Number(process.env.HOLD_MS ?? 400);
const answerMs = Number(process.env.ANSWER_MS ?? 50);
const mcpMs = Number(process.env.MCP_MS ?? 300);
// Ответ «принято» опаздывает на ACCEPT_DELAY_MS после того, как ход уже подхватил
// сообщение: так под нагрузкой поток событий обгоняет ответ на POST.
const acceptDelayMs = Number(process.env.ACCEPT_DELAY_MS ?? 0);
let mcpReady = false;
if (mode === 'no-server') process.exit(2);

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
let stream;
let busy = false;
let release;
let current = 'ses-1';
let resumed = false;

const emit = (type, promptId, data = {}) =>
  stream?.write(`data: ${JSON.stringify({ type, promptId, data })}\n\n`);
const chunk = (promptId, text) =>
  emit('session_update', promptId, {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
const body = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (part) => (raw += part));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
const reply = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url === '/health') return reply(res, 200, { status: 'ok' });
  if (req.method === 'POST' && url === '/session') {
    void wait(mcpMs).then(() => (mcpReady = true));
    if (persistent) {
      current = nextId('ses');
      change((state) => {
        state.sessions[current] = { prompts: [] };
        state.log.push(`new ${current}`);
      });
    }
    return reply(res, 200, { sessionId: current });
  }
  const resuming = /^\/session\/([^/]+)\/resume$/.exec(url);
  if (req.method === 'POST' && resuming) {
    const { cwd } = await body(req);
    if (!load().sessions[resuming[1]]) return reply(res, 404, { code: 'session_not_found' });
    current = resuming[1];
    resumed = true;
    mcpReady = true;
    change((state) => state.log.push(`resume ${current} cwd=${cwd}`));
    return reply(res, 200, { sessionId: current });
  }
  const closing = /^\/session\/([^/]+)$/.exec(url);
  if (req.method === 'DELETE' && closing) {
    change((state) => state.log.push(`close ${closing[1]}`));
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'POST' && url === '/sessions/delete') {
    const { sessionIds } = await body(req);
    for (const id of sessionIds) remove(id);
    return reply(res, 200, { removed: sessionIds, errors: [] });
  }
  if (url === '/workspace/mcp') {
    return reply(res, 200, { discoveryState: mcpReady ? 'completed' : 'in_progress' });
  }
  if (url === `/session/${current}/events`) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    stream = res;
    if (resumed) {
      // Прежние ходы сессии — их события, не ответ нового хода.
      chunk('old-1', 'старый ответ');
      emit('turn_complete', 'old-1', { promptId: 'old-1' });
      emit('turn_error', 'old-2', { message: 'старая ошибка' });
    }
    return;
  }
  if (url === `/session/${current}/prompt`) {
    const { prompt } = await body(req);
    change((state) => state.sessions[current]?.prompts.push(prompt[0].text));
    reply(res, 202, { promptId: 'p1' });
    busy = true;
    void runTurn(prompt[0].text);
    return;
  }
  if (url === `/session/${current}/mid-turn-message`) {
    const { message } = await body(req);
    if (!busy) return reply(res, 200, { accepted: false, reason: 'session_idle' });
    if (acceptDelayMs > 0) {
      release?.(message);
      await wait(acceptDelayMs);
      return reply(res, 200, { accepted: true });
    }
    reply(res, 200, { accepted: true });
    release?.(message);
    return;
  }
  if (url.startsWith(`/session/${current}/permission/`)) {
    const { outcome } = await body(req);
    reply(res, 200, { ok: true });
    release?.(outcome.optionId ?? outcome.outcome);
    return;
  }
  reply(res, 404, {});
}).listen(port, '127.0.0.1');

async function runTurn(prompt) {
  chunk('p1', `ответ на ${prompt.slice(-12)}`);
  if (mode === 'fail') {
    emit('turn_error', 'p1', { message: 'model refused' });
    busy = false;
    return;
  }
  if (mode === 'mcp') chunk('p1', mcpReady ? ' / mcp: есть' : ' / mcp: нет');
  if (mode === 'permission') {
    emit('permission_request', 'p1', {
      requestId: 'req-1',
      options: [
        { optionId: 'proceed_once', kind: 'allow_once' },
        { optionId: 'cancel', kind: 'reject_once' },
      ],
    });
  }
  const got = await new Promise((resolve) => {
    release = resolve;
    setTimeout(() => resolve(undefined), holdMs);
  });
  release = undefined;
  if (mode === 'permission') chunk('p1', ` / разрешение: ${got ?? 'нет ответа'}`);
  if (got && mode === 'inject') {
    emit('mid_turn_message_injected', 'p1', {});
    chunk('p1', ` / учёл: ${got}`);
  }
  emit('turn_complete', 'p1', { promptId: 'p1' });
  if (got && mode === 'pending') {
    await wait(20);
    emit('pending_prompt_started', 'p2', {});
    await wait(answerMs);
    chunk('p2', `учёл: ${got}`);
    emit('turn_complete', 'p2', { promptId: 'p2' });
  }
  busy = false;
}
