// Подделка `kimi web` (Kimi Code 2.1.1) для тестов живого хода: конверт
// {code,msg,data}, токен в stdout, пути и смысл — снятые с настоящего CLI.
// Режим — FAKE_MODE: `ok` (сообщение посреди хода вливается в тот же ход),
// `late` (ход кончается раньше, чем придёт сообщение, — CLI начинает его
// следующим ходом, ответ идёт ANSWER_MS; ответ на сам запрос задержан на
// REPLY_DELAY_MS — окно, в котором сессия уже простаивает, а отправка ещё в
// пути), `permission` (инструмент просит разрешения), `fail` (ход провален),
// `no-server` (подкоманды нет).
// Запрос хода без модели — отказ: сервер `default_model` сам не подставляет.
// Невлитое сообщение из очереди, как у CLI, начинается следующим ходом — его
// ответ «следом: …», влитое отвечено в том же ходе «учёл: …».
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';

const mode = process.env.FAKE_MODE ?? 'ok';
const holdMs = Number(process.env.HOLD_MS ?? 400);
const answerMs = Number(process.env.ANSWER_MS ?? 50);
const replyDelayMs = Number(process.env.REPLY_DELAY_MS ?? 0);
if (mode === 'no-server') process.exit(2);

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const TOKEN = 'tok-1';
const messages = [];
const queued = [];
const approvals = [];
let active;
let release;
let lastReason;
let seq = 0;
let prompts = 0;

const ok = (res, data) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'r' }));
};
const fail = (res, code, msg) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code, msg, data: null, request_id: 'r' }));
};
const body = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (part) => (raw += part));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (role, promptId, text) =>
  messages.push({ id: `m${++seq}`, role, prompt_id: promptId, content: [{ type: 'text', text }] });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 40100, 'unauthorized');
  if (path === '/api/v1/healthz') return ok(res, { ok: true });
  if (path === '/api/v1/config') return ok(res, { providers: {}, default_model: 'stub' });
  if (req.method === 'POST' && path === '/api/v1/sessions') {
    const { metadata } = await body(req);
    if (!metadata?.cwd) return fail(res, 40000, 'cwd required');
    return ok(res, { id: 'ses-1' });
  }
  if (path === '/api/v1/sessions/ses-1') {
    return ok(res, {
      id: 'ses-1',
      busy: Boolean(active),
      pending_interaction: approvals.length > 0 ? 'approval' : 'none',
      ...(lastReason ? { last_turn_reason: lastReason } : {}),
    });
  }
  if (req.method === 'POST' && path === '/api/v1/sessions/ses-1/prompts') {
    const { content, model } = await body(req);
    if (model !== 'stub') return fail(res, 40001, 'model required');
    const prompt = { prompt_id: `p${++prompts}`, text: content[0].text };
    if (active) {
      queued.push(prompt);
      return ok(res, { prompt_id: prompt.prompt_id, status: 'queued' });
    }
    // В `late` второе сообщение приходит в простаивающую сессию — CLI начинает его сам.
    if (mode === 'late' && prompts > 1) {
      await wait(replyDelayMs);
      void runTurn(prompt, true);
    } else {
      void runTurn(prompt, false);
    }
    return ok(res, { prompt_id: prompt.prompt_id, status: 'running' });
  }
  if (path === '/api/v1/sessions/ses-1/prompts:steer') {
    const { prompt_ids: ids } = await body(req);
    const index = queued.findIndex((prompt) => prompt.prompt_id === ids[0]);
    if (!active || !release || index < 0) return fail(res, 40402, 'no active prompt to steer into');
    const [prompt] = queued.splice(index, 1);
    release(prompt.text);
    return ok(res, { steered: true, prompt_ids: ids });
  }
  if (path === '/api/v1/sessions/ses-1/prompts') {
    return ok(res, { active: active ?? null, queued });
  }
  if (path === '/api/v1/sessions/ses-1/messages') {
    const role = url.searchParams.get('role');
    const size = Number(url.searchParams.get('page_size') ?? 100);
    const items = messages.filter((message) => !role || message.role === role).reverse();
    return ok(res, { items: items.slice(0, size) });
  }
  if (path === '/api/v1/sessions/ses-1/approvals') {
    // Как настоящий 2.1.1: без `status=pending` — отказ конвертом (Server API:
    // «`status=pending` is required»), а не пустой список.
    if (url.searchParams.get('status') !== 'pending') {
      return fail(res, 40001, 'status: Invalid input: expected "pending"');
    }
    return ok(res, { items: approvals });
  }
  if (path.startsWith('/api/v1/sessions/ses-1/approvals/')) {
    const { decision } = await body(req);
    approvals.length = 0;
    release?.(`разрешение: ${decision}`);
    return ok(res, { resolved: true, resolved_at: Date.now() });
  }
  if (path === '/api/v1/sessions/ses-1:delete') {
    process.stderr.write('session deleted\n');
    return ok(res, { deleted: true });
  }
  return fail(res, 40400, 'not found');
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Kimi Code web: http://127.0.0.1:${port}/#token=${TOKEN}\n`);
});

async function runTurn(prompt, startedByMessage) {
  active = { prompt_id: prompt.prompt_id, status: 'running' };
  lastReason = undefined;
  if (startedByMessage) {
    await wait(answerMs);
    say('assistant', prompt.prompt_id, `следом: ${prompt.text}`);
    finish();
    return;
  }
  say('assistant', prompt.prompt_id, `ответ на ${prompt.text.slice(-12)}`);
  if (mode === 'fail') {
    say('system', prompt.prompt_id, 'model refused');
    messages.splice(messages.length - 2, 1);
    active = undefined;
    lastReason = 'failed';
    return;
  }
  if (mode === 'permission') {
    approvals.push({ approval_id: 'ap-1', session_id: 'ses-1', tool_name: 'Shell' });
  }
  if (mode === 'late') {
    active = undefined;
    lastReason = 'completed';
    return;
  }
  const got = await new Promise((resolve) => {
    release = resolve;
    setTimeout(() => resolve(undefined), holdMs);
  });
  release = undefined;
  if (got) say('assistant', prompt.prompt_id, mode === 'permission' ? got : `учёл: ${got}`);
  finish();
}

/** Конец хода; невлитое из очереди CLI начинает следующим ходом. */
function finish() {
  active = undefined;
  lastReason = 'completed';
  const next = queued.shift();
  if (next) void runTurn(next, true);
}
