/**
 * Живое доказательство: сессия вне панели (терминал, VS Code) управляется с
 * телефона — вопрос и запрос прав решаются оттуда или в окне, что раньше, а
 * сообщение с телефона агент читает посреди хода.
 *
 * Не подменяется ничего, кроме модели: настоящий `claude` в том потоковом
 * режиме, что у VS Code (`--input-format stream-json` + запрос прав через
 * stdio — это и есть «окно»), одноразовый каталог настроек с хуками панели —
 * те же три, что описывает `RELAY_HOOKS` в `outside-relay-install.ts`, команда берётся с самого
 * стенда (`GET /api/outside/relay`), — и настоящие маршруты на стенде. Решение
 * шлётся тем же запросом, что телефон. Свидетель — тело запросов CLI к модели:
 * результат вызова и текст, дошедший до агента.
 *
 * Строки:
 *   1. вопрос, телефон первым: ответ в результате вызова, окно отменено CLI;
 *   2. вопрос, окно первым: ответ из окна, запрос с телефона снят (409) — и когда
 *      сессия жива (хук видит ответ в транскрипте), и когда CLI сразу вышел;
 *   3. права, телефон «разрешить»: команда выполнилась, окно отменено;
 *   4. права, телефон «запретить»: отказ с причиной, команда не шла;
 *   5. ответ на чужой вызов / кривое тело / решение не того рода — 409 / 400 / 409;
 *   6. сообщение посреди хода — агент получает его после шага (PostToolUse),
 *      телефон видит «передано»;
 *   7. сообщение к концу хода — ход продолжается с ним (Stop);
 *   8. выключено: запрос сразу только в окне, сообщение не принимается (409).
 *
 * Нужны стенд (`pnpm dev`) и `claude` на PATH. Переключатель стенда
 * возвращается в прежнее положение. Настроек Claude Code человека не трогает.
 * Выход 1 — хоть одна строка FAIL, 2 — стенд не отвечает или без маршрутов
 * `/api/outside/*`. `RELAY_DEBUG=1` печатает ход каждого прогона.
 *
 * Запуск: node tools/qa/check-outside-relay.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PANEL_URL ?? 'http://127.0.0.1:5178';
const TOKEN = (() => {
  try {
    return readFileSync(join(homedir(), '.agentdeck', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();
const QUESTION = 'Какой цвет?';
const QUESTIONS = [
  {
    question: QUESTION,
    header: 'Цвет',
    multiSelect: false,
    options: [
      { label: 'Красный', description: 'тёплый' },
      { label: 'Синий', description: 'холодный' },
    ],
  },
];
/** Команда, которой CLI без разрешения не даст хода и чей вывод виден в результате. */
const BASH = { command: `node -e "console.log('relay-'+'ran')"`, description: 'проверка' };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const debug = (...a) => process.env.RELAY_DEBUG && console.error('[relay]', ...a);

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${TOKEN}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const toolUse = (id, name, input) => ({
  blocks: [
    [
      { type: 'tool_use', id, name, input: {} },
      { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    ],
  ],
  stop: 'tool_use',
});
const say = (text) => ({
  blocks: [
    [
      { type: 'text', text: '' },
      { type: 'text_delta', text },
    ],
  ],
  stop: 'end_turn',
});
const resultOf = (body, id) =>
  (body.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id);

/**
 * Модель-заглушка. Запросы основного цикла (с инструментами) решает `respond`
 * сценария и складывает в `requests`; служебные (заголовок, классификатор)
 * получают «ок».
 */
function startModel(respond) {
  const requests = [];
  const sse = (res, { blocks, stop }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: `m${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    blocks.forEach(([start, delta], index) => {
      send('content_block_start', { type: 'content_block_start', index, content_block: start });
      send('content_block_delta', { type: 'content_block_delta', index, delta });
      send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop },
      usage: { output_tokens: 1 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      if (req.url.includes('count_tokens')) return res.end(JSON.stringify({ input_tokens: 1 }));
      if (!req.url.includes('/messages')) return res.end('{}');
      const body = JSON.parse(raw || '{}');
      if (!(body.tools ?? []).some((tool) => tool.name === 'Bash')) return sse(res, say('ок'));
      requests.push(body);
      sse(res, await respond(body, requests.length));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => server.close(),
      }),
    ),
  );
}

/**
 * Один ход настоящего CLI с хуками панели. `respond` — ответы модели,
 * `window(request)` — что «окно» отвечает на запрос прав по stdio (`undefined`
 * — молчит, как человек, не дошедший до компьютера), `act(session)` — что
 * делает телефон, когда известен id сессии, `whileAlive()` — что он делает после
 * конца хода, пока сессия ещё открыта (VS Code держит её между ходами).
 */
async function runTurn({ command, respond, window = () => undefined, act, whileAlive }) {
  const model = await startModel(respond);
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-relay-home-')));
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-relay-work-')));
  writeFileSync(join(work, 'note.txt'), 'заметка\n');
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 3600 }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
      },
    }),
  );
  let stdout = '';
  let sessionId;
  const windowAsks = [];
  let cancelled = false;
  let resolveSession;
  const session = new Promise((done) => (resolveSession = done));
  let resolveResult;
  const finished = new Promise((done) => (resolveResult = done));
  const cli = spawn(
    'claude',
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      // Режим прав окружения (авторежим) не должен решать за окно и телефон.
      '--permission-mode',
      'default',
    ],
    {
      cwd: work,
      shell: true,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: model.url,
        ANTHROPIC_API_KEY: 'stub',
        ANTHROPIC_AUTH_TOKEN: 'stub',
        ANTHROPIC_MODEL: 'stub',
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  );
  cli.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'сделай' } }) + '\n',
  );
  let seen = 0;
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    for (const line of lines.slice(seen, -1)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!sessionId && record.session_id) {
        sessionId = record.session_id;
        resolveSession(sessionId);
      }
      if (record.type === 'control_cancel_request') cancelled = true;
      if (record.type === 'control_request' && record.request?.subtype === 'can_use_tool') {
        windowAsks.push(record.request.tool_name);
        void Promise.resolve(window(record.request)).then((response) => {
          if (!response) return;
          cli.stdin.write(
            JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: record.request_id, response },
            }) + '\n',
          );
        });
      }
      if (record.type === 'result') resolveResult(true);
    }
    seen = lines.length - 1;
  });
  const actResult = await act(await session);
  debug('act', actResult);
  const done = await Promise.race([finished, sleep(90_000).then(() => false)]);
  debug('finished', done, 'window', windowAsks, 'cancelled', cancelled);
  if (!done) debug('stdout tail', stdout.slice(-2000));
  const alive = done && whileAlive ? await whileAlive() : undefined;
  cli.stdin.end();
  if (!done) cli.kill();
  await new Promise((resolve) => (cli.exitCode !== null ? resolve() : cli.on('close', resolve)));
  model.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return { done, sessionId, windowAsks, cancelled, requests: model.requests, actResult, alive };
}

/** Решение с телефона, как только хук зарегистрировал запрос (до того — 409). */
async function decideWhenRegistered(toolUseId, body) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const reply = await api('POST', `/api/outside/asks/${toolUseId}/answer`, body);
    if (reply.status !== 409) return reply.status;
    await sleep(300);
  }
  return 409;
}

/** Хук отозвался из сессии — до первого шага это может быть только регистрация запроса. */
async function hookedSoon(sessionId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const reply = await api('GET', `/api/outside/messages?sessionId=${sessionId}`);
    if (reply.body?.hooked) return true;
    await sleep(300);
  }
  return false;
}

const text = (block) =>
  typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content ?? '');

const rows = [];
const row = (name, expected, actual, ok) => rows.push({ name, expected, actual, ok });

const before = await api('GET', '/api/outside/relay');
if (before.status !== 200 || typeof before.body?.command !== 'string') {
  console.error(`Стенд ${BASE} не отвечает или старый: ${before.status}`);
  process.exit(2);
}
const command = before.body.command;
const stamp = Date.now();
try {
  await api('PATCH', '/api/outside/relay', { enabled: true });

  // 1. Вопрос, телефон первым.
  {
    const id = `toolu_relay_${stamp}a`;
    const turn = await runTurn({
      command,
      respond: (body) =>
        resultOf(body, id)
          ? say('готово')
          : toolUse(id, 'AskUserQuestion', { questions: QUESTIONS }),
      act: () => decideWhenRegistered(id, { answers: { [QUESTION]: 'Синий' } }),
    });
    const result = turn.requests.map((body) => resultOf(body, id)).find(Boolean);
    row(
      '1. вопрос: телефон первым',
      'answer 200; «"Какой цвет?"="Синий"»; окно спросило и отменено',
      `answer ${turn.actResult}; ${text(result).slice(0, 80)}; окно ${turn.windowAsks}; отмена ${turn.cancelled}`,
      turn.done &&
        turn.actResult === 200 &&
        text(result).includes('="Синий"') &&
        result?.is_error !== true &&
        turn.cancelled,
    );
  }

  // 2. Вопрос, окно первым: сессия жива — хук видит ответ в транскрипте и
  // отпускает запрос сам; CLI вышел сразу (и убил хук) — запрос снимает молчание.
  for (const [mark, alive] of [
    ['b', true],
    ['h', false],
  ]) {
    const id = `toolu_relay_${stamp}${mark}`;
    let registered = false;
    let turnSession;
    const lateAnswer = () =>
      api('POST', `/api/outside/asks/${id}/answer`, { answers: { [QUESTION]: 'Синий' } });
    const turn = await runTurn({
      command,
      respond: (body) =>
        resultOf(body, id)
          ? say('готово')
          : toolUse(id, 'AskUserQuestion', { questions: QUESTIONS }),
      window: async (request) => {
        registered = await hookedSoon(turnSession);
        return {
          behavior: 'allow',
          updatedInput: { ...request.input, answers: { [QUESTION]: 'Красный' } },
        };
      },
      act: async (session) => {
        turnSession = session;
        return 'окно';
      },
      // Хук смотрит транскрипт между срезами ожидания (3 с).
      ...(alive ? { whileAlive: () => sleep(7_000).then(lateAnswer) } : {}),
    });
    // Молчание хука засчитывается через 15 с.
    const late = alive ? turn.alive : await sleep(20_000).then(lateAnswer);
    const result = turn.requests.map((body) => resultOf(body, id)).find(Boolean);
    row(
      alive ? '2a. вопрос: окно первым, сессия жива' : '2b. вопрос: окно первым, CLI вышел',
      'хук зарегистрировал; «="Красный"»; ответ с телефона потом 409',
      `хук ${registered}; ${text(result).slice(0, 80)}; телефон ${late?.status}`,
      turn.done && registered && text(result).includes('="Красный"') && late?.status === 409,
    );
  }

  // 3–4. Права: телефон разрешает и запрещает.
  for (const [mark, behavior] of [
    ['c', 'allow'],
    ['d', 'deny'],
  ]) {
    const id = `toolu_relay_${stamp}${mark}`;
    const turn = await runTurn({
      command,
      respond: (body) => (resultOf(body, id) ? say('готово') : toolUse(id, 'Bash', BASH)),
      act: () => decideWhenRegistered(id, { behavior }),
    });
    const result = turn.requests.map((body) => resultOf(body, id)).find(Boolean);
    const ran = text(result).includes('relay-ran');
    row(
      behavior === 'allow' ? '3. права: телефон разрешил' : '4. права: телефон запретил',
      behavior === 'allow'
        ? 'answer 200; вывод relay-ran; окно отменено'
        : 'answer 200; отказ «…с телефона»; команда не шла',
      `answer ${turn.actResult}; ${text(result).slice(0, 70)}; отмена ${turn.cancelled}`,
      turn.done &&
        turn.actResult === 200 &&
        turn.cancelled &&
        (behavior === 'allow'
          ? ran && result?.is_error !== true
          : !ran && result?.is_error === true && text(result).includes('телефон')),
    );
  }

  // 5. Чужой вызов, кривое тело, решение не того рода.
  {
    const foreign = await api('POST', `/api/outside/asks/toolu_nobody_${stamp}/answer`, {
      behavior: 'allow',
    });
    const bad = await api('POST', `/api/outside/asks/toolu_nobody_${stamp}/answer`, {
      answers: 'x',
    });
    const id = `toolu_relay_${stamp}e`;
    let wrongKind;
    await runTurn({
      command,
      respond: (body) => (resultOf(body, id) ? say('готово') : toolUse(id, 'Bash', BASH)),
      act: async () => {
        // Ответ вариантами на запрос прав хук отдать не может — отказ, запрос ждёт.
        const deadline = Date.now() + 40_000;
        do {
          wrongKind = (await api('POST', `/api/outside/asks/${id}/answer`, { answers: { q: 'a' } }))
            .status;
          const rightKind = await api('POST', `/api/outside/asks/${id}/answer`, {
            behavior: 'deny',
          });
          if (rightKind.status === 200) return rightKind.status;
          await sleep(300);
        } while (Date.now() < deadline);
        return 409;
      },
    });
    row(
      '5. чужой вызов / кривое тело / не того рода',
      '409 / 400 / 409',
      `${foreign.status} / ${bad.status} / ${wrongKind}`,
      foreign.status === 409 && bad.status === 400 && wrongKind === 409,
    );
  }

  // 6. Сообщение посреди хода — после шага (PostToolUse).
  {
    const id = `toolu_relay_${stamp}f`;
    const mark = `проверь ещё вёрстку ${stamp}`;
    let queued;
    const ready = new Promise((done) => (queued = done));
    let status;
    const turn = await runTurn({
      command,
      respond: async (_body, n) => {
        if (n === 1) {
          await ready;
          return toolUse(id, 'Read', { file_path: 'note.txt' });
        }
        return say('учёл');
      },
      act: async (session) => {
        const reply = await api('POST', '/api/outside/messages', {
          sessionId: session,
          text: mark,
        });
        queued();
        status = reply.status;
        return session;
      },
    });
    const after = await api('GET', `/api/outside/messages?sessionId=${turn.sessionId}`);
    const reached = turn.requests.slice(1).some((body) => JSON.stringify(body).includes(mark));
    const delivered = after.body?.messages?.find((message) => message.text === mark);
    row(
      '6. сообщение после шага',
      'POST 200; текст в следующем запросе к модели; «передано», hooked',
      `POST ${status}; дошло ${reached}; deliveredAt ${Boolean(delivered?.deliveredAt)}; hooked ${after.body?.hooked}`,
      turn.done &&
        status === 200 &&
        reached &&
        Boolean(delivered?.deliveredAt) &&
        after.body?.hooked,
    );
  }

  // 7. Сообщение к концу хода — ход продолжается (Stop).
  {
    const mark = `и допиши тесты ${stamp}`;
    let queued;
    const ready = new Promise((done) => (queued = done));
    const turn = await runTurn({
      command,
      respond: async (_body, n) => {
        if (n === 1) await ready;
        return say(n === 1 ? 'сделал' : 'дописал');
      },
      act: async (session) => {
        await api('POST', '/api/outside/messages', { sessionId: session, text: mark });
        queued();
        return session;
      },
    });
    const reached = turn.requests.slice(1).some((body) => JSON.stringify(body).includes(mark));
    row(
      '7. сообщение к концу хода',
      'ход продолжен: второй запрос к модели несёт текст',
      `запросов ${turn.requests.length}; дошло ${reached}`,
      turn.done && turn.requests.length >= 2 && reached,
    );
  }

  // 8. Выключено.
  {
    await api('PATCH', '/api/outside/relay', { enabled: false });
    const id = `toolu_relay_${stamp}g`;
    let message;
    const turn = await runTurn({
      command,
      respond: (body) => (resultOf(body, id) ? say('готово') : toolUse(id, 'Bash', BASH)),
      window: () => ({ behavior: 'deny', message: 'окно' }),
      act: async (session) => {
        message = (await api('POST', '/api/outside/messages', { sessionId: session, text: 'x' }))
          .status;
        await sleep(3_000);
        return (await api('POST', `/api/outside/asks/${id}/answer`, { behavior: 'allow' })).status;
      },
    });
    row(
      '8. выключено',
      'окно спросило; решение с телефона 409; сообщение 409',
      `окно ${turn.windowAsks}; answer ${turn.actResult}; сообщение ${message}`,
      turn.done && turn.windowAsks.includes('Bash') && turn.actResult === 409 && message === 409,
    );
  }
} finally {
  await api('PATCH', '/api/outside/relay', { enabled: before.body.enabled });
}

console.table(
  rows.map(({ name, expected, actual, ok }) => ({
    name,
    expected,
    actual,
    verdict: ok ? 'OK' : 'FAIL',
  })),
);
const failed = rows.filter((item) => !item.ok).length;
console.log(failed ? `FAIL: ${failed} из ${rows.length}` : `OK: ${rows.length} из ${rows.length}`);
process.exit(failed ? 1 : 0);
