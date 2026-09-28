/**
 * Обвязка проверки телефона на эмуляторе (`check-mobile-device.mjs`):
 * одноразовый проект со своими кейсами, транскрипт с вопросом агента,
 * фальшивый `claude` и прокси между телефоном и одноразовой панелью.
 *
 * Прокси нужен ровно там, где настоящую панель не заставить ответить нужным
 * кадром без настоящей модели: карточка агента панели с числом, поток хода
 * агента панели (пинги, тишина, обрыв), битый разговор, код ошибки прогона,
 * которого у сервера сейчас нет. Всё остальное — тесты, ручной прогон, история
 * прогонов, чат, 409 `run_busy` — отвечает настоящая одноразовая панель.
 */
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_ID = '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

/** Каталог транскриптов проекта так, как его называет CLI. */
export const transcriptDir = (cfg, cwd) => join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

export const QUESTIONS = [
  {
    question: 'Which login stays the default?',
    header: 'Login',
    multiSelect: false,
    options: [{ label: 'QR code' }, { label: 'Manual entry' }],
  },
  {
    question: 'What to check after the change?',
    header: 'Checks',
    multiSelect: true,
    options: [{ label: 'Unit' }, { label: 'E2E' }, { label: 'APK build' }],
  },
];

/**
 * Транскрипт разговора с неотвеченным `AskUserQuestion`: так его оставляет
 * панель, отказавшая вопросу (ответ придёт следующим сообщением).
 */
export function seedTranscript(cfg, project) {
  const dir = transcriptDir(cfg, project);
  mkdirSync(dir, { recursive: true });
  const at = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();
  const base = { sessionId: SESSION_ID, cwd: project };
  const lines = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: at(120_000),
      message: { role: 'user', content: 'Set up the phone login' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(90_000),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_dev_ask_1',
            name: 'AskUserQuestion',
            input: { questions: QUESTIONS },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      timestamp: at(89_000),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_dev_ask_1',
            is_error: true,
            content: 'The answer comes as the next message.',
          },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: at(88_000),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Waiting for your answers.' }],
      },
    },
  ];
  writeFileSync(
    join(dir, `${SESSION_ID}.jsonl`),
    lines.map((line) => JSON.stringify({ ...base, ...line })).join('\n') + '\n',
    'utf8',
  );
}

/**
 * Своя команда автотестов проекта: пишет JUnit с одним упавшим и одним
 * прошедшим кейсом и выходит с 1 — как настоящий красный набор.
 */
export function seedAutomation(project) {
  const dir = join(project, '.agent', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(project, 'fake-e2e.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      'const report = process.env.AGENTDECK_JUNIT_REPORT;',
      'const xml = `<?xml version="1.0"?><testsuites><testsuite name="dev" tests="2" failures="1">' +
        '<testcase classname="dev" name="[gui-001] manual ref case" time="0.1"><failure message="boom">boom</failure></testcase>' +
        '<testcase classname="dev" name="[gui-002] second case" time="0.1"></testcase>' +
        '</testsuite></testsuites>`;',
      'if (report) writeFileSync(report, xml);',
      'process.exit(1);',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'automation.json'),
    `${JSON.stringify({ version: 1, command: 'node fake-e2e.mjs' })}\n`,
    'utf8',
  );
}

/** Запись истории прогонов, остановленного перезапуском панели (код + русский текст). */
export function seedOrphanRun(project) {
  const dir = join(project, '.agent', 'tests', 'runs');
  mkdirSync(dir, { recursive: true });
  const id = '20260927000000-deadbeef';
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(
    join(dir, `${id}.run.json`),
    `${JSON.stringify(
      {
        id,
        mode: 'retest',
        actor: 'agent',
        status: 'error',
        startedAt,
        finishedAt: startedAt,
        error: 'Панель перезапустилась во время прогона.',
        messageCode: 'orphan-run-stopped',
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, unknown: 0 },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return id;
}

/**
 * Фальшивый `claude` для чата: stream-json в обе стороны, один процесс на
 * разговор. Реплика со словом HOLD держит ход `HOLD_MS` — так живёт «ход с
 * компьютера», в который телефон шлёт ответ. Реплики пишутся в транскрипт
 * сразу, как это делает настоящий CLI: ответ человека закрывает вопрос на
 * сервере, и между концом хода и этой записью карточку прячет только телефон.
 */
export const FAKE_CHAT_CLI = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
const LOG = self.replace(/[^\\/]+$/, 'calls.jsonl');
const ALIVE = self.replace(/[^\\/]+$/, '.stand-alive');
const PARENT = process.ppid;
// Панель, убитая снаружи (таймаут раннера на Windows), не снимает свой каталог:
// тогда выходим по смерти родителя, а не живём вечно.
const parentAlive = () => { try { process.kill(PARENT, 0); return true; } catch { return false; } };
setInterval(() => { if (!existsSync(ALIVE) || !parentAlive()) process.exit(0); }, 250).unref();
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write('2.1.0 (Claude Code)\n'); process.exit(0); }
// Новый разговор без флага сессии получает свою сессию, как у настоящего CLI:
// общий 'dev-session' склеил бы транскрипты разных чатов одного прогона проверки.
const sid = after('--resume') ?? after('--session-id') ?? crypto.randomUUID();
const HOLD_MS = Number(process.env.FAKE_HOLD_MS ?? 60000);
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
const TRANSCRIPT = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'projects',
  process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const record = (role, content) => appendFileSync(TRANSCRIPT, JSON.stringify({ type: role,
  uuid: role + Date.now() + Math.random(), sessionId: sid, cwd: process.cwd(),
  timestamp: new Date().toISOString(), message: { role, content } }) + '\n');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// Ход ASKTASK — как у настоящего CLI 2.1.282 в панели (замерено 28.09 стабом
// модели): вопрос AskUserQuestion, отказ брокера ошибкой, фоновый субагент
// (расписка «Async agent launched»), его итог — репликой-уведомлением
// <task-notification> СТРОКОЙ от имени пользователя, и ход идёт дальше.
async function askTask(text) {
  record('user', text);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-dev', cwd: process.cwd(), tools: [] });
  const ask = [{ type: 'text', text: 'Let me ask.' },
    { type: 'tool_use', id: 'toolu_desk_ask', name: 'AskUserQuestion', input: { questions: DESK_QUESTIONS } }];
  record('assistant', ask);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: ask } });
  const denied = [{ type: 'tool_result', tool_use_id: 'toolu_desk_ask', is_error: true,
    content: 'The question is shown to the human as a card with buttons, the answer comes as the next message.' }];
  record('user', denied);
  out({ type: 'user', session_id: sid, message: { role: 'user', content: denied } });
  const task = [{ type: 'tool_use', id: 'toolu_desk_task', name: 'Agent',
    input: { description: 'Scan the repo', subagent_type: 'general-purpose', prompt: 'scan' } }];
  record('assistant', task);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: task } });
  const launched = [{ type: 'tool_result', tool_use_id: 'toolu_desk_task',
    content: [{ type: 'text', text: 'Async agent launched successfully. agentId: a1b2c3' }] }];
  record('user', launched);
  out({ type: 'user', session_id: sid, message: { role: 'user', content: launched } });
  await pause(Number(process.env.FAKE_SUB_MS ?? 170000));
  record('user', '<task-notification>\n<task-id>a1b2c3</task-id>\n<tool-use-id>toolu_desk_task</tool-use-id>\n' +
    '<status>completed</status>\n<summary>Agent "Scan the repo" completed</summary>\n</task-notification>');
  appendFileSync(LOG, JSON.stringify({ at: Date.now(), sid, notice: 'toolu_desk_task' }) + '\n');
  await pause(Number(process.env.FAKE_TAIL_MS ?? 120000));
  const reply = 'Waiting for your answer.';
  record('assistant', [{ type: 'text', text: reply }]);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: reply, num_turns: 1,
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  appendFileSync(LOG, JSON.stringify({ at: Date.now(), sid, done: text.slice(0, 40) }) + '\n');
}
// Ход BGTURN — долгий ход агента панели (F-101 на настоящем сервере): начало
// сразу, конец через FAKE_BG_MS, пока телефон в фоне и без сети.
async function bgTurn() {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-dev', cwd: process.cwd(), tools: [] });
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'BG-TURN-STARTED' }] } });
  await pause(Number(process.env.FAKE_BG_MS ?? 60000));
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: ' BG-TURN-FINISHED' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'BG-TURN-STARTED BG-TURN-FINISHED',
    num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  appendFileSync(LOG, JSON.stringify({ at: Date.now(), sid, done: 'BGTURN' }) + '\n');
}
const DESK_QUESTIONS = [{ question: 'Which stack for the desk task?', header: 'Stack', multiSelect: false,
  options: [{ label: 'Keep React' }, { label: 'Try Svelte' }] }];
async function turn(text) {
  appendFileSync(LOG, JSON.stringify({ at: Date.now(), sid, text }) + '\n');
  if (text.includes('ASKTASK')) return askTask(text);
  if (text.includes('BGTURN')) return bgTurn();
  const hold = text.includes('HOLD');
  // Ход HOLD изображает работу с компьютера, которая вопрос НЕ отвечает: его
  // реплика в транскрипт не пишется, иначе сервер закрыл бы вопрос сам.
  // FAKE_RECORD_DELAY_MS — медленная запись реплики (хуки, диск): расширяет окно,
  // в котором сервер ещё держит вопрос, а телефон уже отправил ответ.
  const recordDelay = Number(process.env.FAKE_RECORD_DELAY_MS ?? 0);
  if (!hold && recordDelay > 0) await new Promise((done) => setTimeout(done, recordDelay));
  if (!hold) record('user', text);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-dev', cwd: process.cwd(), tools: [] });
  const reply = hold ? 'HOLDING the turn' : 'ACK: ' + text;
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  if (hold) await new Promise((done) => setTimeout(done, HOLD_MS));
  record('assistant', [{ type: 'text', text: reply }]);
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: reply, num_turns: 1,
    total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  appendFileSync(LOG, JSON.stringify({ at: Date.now(), sid, done: text.slice(0, 40) }) + '\n');
}
if (after('--input-format') === 'stream-json') {
  let buffered = '';
  let chain = Promise.resolve();
  for await (const chunk of process.stdin) {
    buffered += chunk.toString('utf8');
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'user') continue;
      const text = textOf(event.message?.content);
      chain = chain.then(() => turn(text));
    }
  }
  await chain;
} else {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
  await turn(Buffer.concat(chunks).toString('utf8'));
}
`;

/** Кадр потока хода агента панели. */
export const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Прокси телефон → одноразовая панель. `routes` — список `{ match(method, path),
 * handle(req, res, url) }`; первый совпавший отвечает сам, остальное уходит
 * наверх как есть (включая потоки). Каждое обращение пишется в `log`.
 */
export function startProxy(upstream) {
  const target = new URL(upstream);
  const routes = [];
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy');
    const entry = { at: Date.now(), method: req.method, path: url.pathname, query: url.search };
    log.push(entry);
    res.on('close', () => (entry.closedAt = Date.now()));
    const route = routes.find((item) => item.match(req.method, url.pathname, url));
    if (route) {
      entry.stubbed = route.name;
      Promise.resolve(route.handle(req, res, url, entry)).catch((error) => {
        entry.error = String(error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: String(error) }));
      });
      return;
    }
    const upstreamReq = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        entry.status = upstreamRes.statusCode;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (error) => {
      entry.error = String(error);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamReq);
    res.on('close', () => upstreamReq.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        routes,
        log,
        close: () => new Promise((done) => server.close(() => done())),
        closeAll: () => server.closeAllConnections?.(),
      });
    });
  });
}

/** Прочитать тело запроса целиком (JSON, если получится). */
export function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(raw);
      }
    });
  });
}

/** Ответ наверху, пропущенный через правку JSON: `patch(body) → body`. */
export async function upstreamJson(upstream, req, url, patch) {
  const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
    method: req.method,
    headers: { authorization: req.headers.authorization ?? '' },
  });
  const body = await res.json();
  return { status: res.status, body: patch(body) };
}

export const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
