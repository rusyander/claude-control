/**
 * Живое доказательство 6.3 плана экономии: что группа разделения в Qwen Code
 * шлёт модели в начале запроса и меняется ли это начало между ходами. Для
 * локальной модели (llama.cpp) это время: изменённое начало сбрасывает кеш
 * слота, и весь разговор считается заново на каждом ходе.
 *
 * Настоящие панель (одноразовый стенд) и `qwen` в живом режиме `serve`;
 * подменены только модель (заглушка OpenAI chat пишет тела запросов) и серверы
 * MCP (заглушки stdio со своими инструментами). Свидетель — тела запросов:
 * - лёгкий набор MCP (1.2) на настоящем Qwen: заглушка модели зовёт
 *   `tool_search` («stub»), и в ответе инструмента у обычного разговора оба
 *   сервера (контроль: серверы подняты), у группы — только трекер;
 * - инструменты MCP в начало запроса не попадают ни у кого: панель открывает
 *   сессию до того, как Qwen поднял серверы, и они доступны только через
 *   `tool_search` — поэтому лёгкий набор начала запроса Qwen не укорачивает.
 *   Покраснеет — Qwen начал класть их в начало, и пункт надо пересмотреть;
 * - второй ход группы — после правки внутри проекта, где в корне больше 20
 *   элементов, как в настоящем репозитории, — начинается с того же `system`,
 *   тех же `tools` и тех же сообщений первого хода, байт в байт. Продолжение
 *   сессии (`resume`) Qwen заново строит стартовую сводку: дату и дерево
 *   каталога, первые 20 элементов от корня. Поэтому начало меняется со сменой
 *   дня и с новым элементом среди этих 20 — не с правкой кода внутри;
 * - фоновых вызовов модели нет там, где их никто не прочтёт: подсказки
 *   следующей реплики (`[SUGGESTION MODE`) — ни у кого, извлечения авто-памяти
 *   и её «сна» — по переписке групп (контроль: у обычного разговора память есть).
 *   Без слоя тишины их было больше основных запросов, и память группы сдвигала
 *   начало второго хода — проверка выше тоже краснела.
 *
 * CLI — из `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH.
 * Нет CLI — «не проверено», код 2. Дом Qwen — дом стенда; `~/.qwen` и
 * `~/.claude` человека не трогаются. `QWEN_PREFIX_DUMP=<файл>` — тела всех
 * запросов в файл для разбора.
 *
 * Запуск: node tools/qa/check-qwen-group-prefix.mjs
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const TRACKER_TOOL = 'stub_tracker_search';
const MESSENGER_TOOL = 'stub_inbox_read';
const PLAIN_WORDS = 'PLAIN-WORDS-p1';
const GROUP_TASK = 'починить валидацию';
const OTHER_TASK = 'убрать лишний отступ';
const SECOND_WORDS = 'SECOND-GROUP-WORDS-g2';

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join(' ')
      : '';
const ofRole = (body, role) =>
  (body?.messages ?? []).filter((message) => message.role === role).map((m) => text(m.content));
const usersOf = (body) => ofRole(body, 'user').join('\n');
const systemOf = (body) => ofRole(body, 'system').join('\n');
const toolsOf = (body) => body?.tools ?? [];
const lastUserOf = (body) => ofRole(body, 'user').at(-1) ?? '';
/** Подсказка следующей реплики: тот же набор инструментов, что у хода, своя реплика в конце. */
const isSuggestion = (body) => lastUserOf(body).trimStart().startsWith('[SUGGESTION MODE');
/** Извлечение авто-памяти и её «сон» — свой системный промпт. */
const isMemory = (body) => /managed memory (extraction subagent|dream)/.test(systemOf(body));
/** Основной запрос хода — с `tool_search`; служебные (подсказка, память) не в счёт. */
const isMain = (body) =>
  toolsOf(body).some((tool) => tool.function?.name === 'tool_search') && !isSuggestion(body);
const isGroupOne = (body) =>
  usersOf(body).includes(GROUP_TASK) && !usersOf(body).includes(OTHER_TASK);

/**
 * Заглушка OpenAI chat: каждый запрос записан. Основной запрос обычного
 * разговора и группы «Форма входа» без ответа инструмента — вызов `tool_search`
 * («stub»); остальное — «OK».
 */
async function startStub() {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // Пустое тело — тоже запрос: записан как есть.
      }
      bodies.push(body);
      if (process.env.QWEN_PREFIX_DUMP) {
        writeFileSync(process.env.QWEN_PREFIX_DUMP, JSON.stringify(bodies, null, 1));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (choice) =>
        res.write(
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [choice] })}\n\n`,
        );
      const answered = (body.messages ?? []).some((message) => message.role === 'tool');
      const probe =
        isMain(body) &&
        !answered &&
        !usersOf(body).includes(SECOND_WORDS) &&
        (usersOf(body).includes(PLAIN_WORDS) || isGroupOne(body));
      if (probe) {
        send({
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${bodies.length}`,
                type: 'function',
                function: { name: 'tool_search', arguments: '{"query":"stub"}' },
              },
            ],
          },
          finish_reason: null,
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
      } else {
        send({ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null });
        send({ index: 0, delta: {}, finish_reason: 'stop' });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Сервер MCP по stdio (строка JSON на сообщение): `initialize`, `tools/list` с
 * инструментами из argv, вызов отвечает «ok».
 */
const MCP_STUB = `
import { createInterface } from 'node:readline';
const tools = process.argv.slice(2).map((name) => ({
  name,
  description: name + ': ' + 'stub tool description '.repeat(20),
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
}));
const send = (message) => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result =
    message.method === 'initialize'
      ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'ok' }] }
          : {};
  send({ jsonrpc: '2.0', id: message.id, result });
});
`;

/** Ответы инструментов в запросах — то, что нашёл `tool_search`. */
const toolResults = (bodies) => bodies.flatMap((body) => ofRole(body, 'tool')).join('\n');
/** Первое расхождение сообщений хода 1 с началом хода 2; -1 — их нет. */
function firstDiff(before, after) {
  const a = before.messages ?? [];
  const b = after.messages ?? [];
  for (let i = 0; i < a.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return -1;
}
/**
 * Ход 2 против последнего запроса хода 1: всё совпадает байт в байт, кроме
 * последней реплики человека хода 1, с которой Qwen снимает свои напоминания
 * (`<system-reminder>`: каталог памяти и т. п.) — они переезжают в новую реплику.
 * Сама реплика (её прочие части) и всё после неё — те же.
 */
function tailOnly(before, after) {
  const a = before.messages ?? [];
  const b = after.messages ?? [];
  const k = firstDiff(before, after);
  if (k === -1) return { ok: true, detail: '' };
  const lastUser = a.map((m) => m.role).lastIndexOf('user');
  const parts = (message) =>
    Array.isArray(message?.content)
      ? message.content
      : [{ type: 'text', text: text(message?.content) }];
  const was = parts(a[k]);
  const now = parts(b[k]);
  const kept = now.every((part, i) => JSON.stringify(part) === JSON.stringify(was[i]));
  const dropped = was.slice(now.length);
  const remindersOnly = dropped.every((part) =>
    text([part]).trimStart().startsWith('<system-reminder>'),
  );
  const restSame = a
    .slice(k + 1)
    .every((message, i) => JSON.stringify(message) === JSON.stringify(b[k + 1 + i]));
  const ok = k === lastUser && kept && dropped.length > 0 && remindersOnly && restSame;
  return {
    ok,
    detail:
      `расхождение в сообщении #${k} (последняя реплика человека — #${lastUser}); частей ${was.length} → ${now.length}, ` +
      `снято только напоминание: ${remindersOnly}, остальное то же: ${restSame}
    ${around(JSON.stringify(a[k]), JSON.stringify(b[k]))}`,
  };
}

/** Где именно расходятся две строки — для диагноза. */
function around(a, b) {
  let k = 0;
  while (k < a.length && a[k] === b[k]) k += 1;
  return `с ${k}-го знака:\n    было  ${JSON.stringify(a.slice(k, k + 300))}\n    стало ${JSON.stringify(b.slice(k, k + 300))}`;
}

console.log('Qwen: что группа шлёт в начале запроса и меняется ли оно между ходами');
const dir = findCli('qwen');
if (!dir) {
  console.log('  Не проверено: «qwen» нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const stub = await startStub();
for (const name of ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']) {
  delete process.env[name];
}

await runOnStand(
  {
    label: 'qwen-group-prefix',
    web: false,
    settings: { provider: 'qwen' },
    extraPath: [dir],
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
      OPENAI_API_KEY: 'x',
      OPENAI_MODEL: 'stub-model',
    },
    seed: ({ home, root }) => {
      const stubs = join(root, 'mcp-stubs');
      mkdirSync(stubs, { recursive: true });
      const server = join(stubs, 'mcp-stub.mjs');
      writeFileSync(server, MCP_STUB);
      // Корень как у настоящего репозитория: больше 20 элементов.
      for (let i = 0; i < 22; i += 1) {
        const pkg = join(root, `pkg-${String(i).padStart(2, '0')}`);
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'index.ts'), `export const n = ${i};\n`);
      }
      mkdirSync(join(home, '.qwen'), { recursive: true });
      writeFileSync(
        join(home, '.qwen', 'settings.json'),
        JSON.stringify({
          mcpServers: {
            jira: { command: process.execPath, args: [server, TRACKER_TOOL] },
            'telegram-inbox': { command: process.execPath, args: [server, MESSENGER_TOOL] },
          },
        }),
      );
    },
  },
  async (stand, check) => {
    if (!existsSync(join(stand.home, '.qwen', 'settings.json'))) {
      throw new NotChecked('настройки Qwen в доме стенда не записаны');
    }
    const chats = async () => (await stand.api('/provider-chat/chats')).body ?? [];
    const idle = async (id) =>
      (await stand.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false;
    const until = async (probe, seconds) => {
      for (let i = 0; i < seconds * 4; i += 1) {
        if (await probe()) return true;
        await wait(250);
      }
      return false;
    };

    // Обычный разговор — полный набор (контроль: серверы MCP подняты).
    const created = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'обычный', workdir: stand.root },
    });
    check('обычный разговор заведён', created.status === 200, created.text.slice(0, 300));
    const plainId = created.body?.id;
    const plainFrom = stub.bodies.length;
    await stand.api(`/provider-chat/chats/${plainId}/send`, {
      method: 'POST',
      body: { text: PLAIN_WORDS },
    });
    await until(() => idle(plainId), 120);
    const plainBodies = stub.bodies.slice(plainFrom);
    const plainFound = toolResults(plainBodies);
    check(
      'контроль: tool_search обычного разговора находит инструменты обоих серверов',
      plainFound.includes(TRACKER_TOOL) && plainFound.includes(MESSENGER_TOOL),
      plainFound.slice(0, 600) || `ответов инструментов нет, запросов ${plainBodies.length}`,
    );
    const plain = plainBodies.find((body) => isMain(body) && usersOf(body).includes(PLAIN_WORDS));

    // Разделение с родителем: разбор и две группы.
    const groupFrom = stub.bodies.length;
    const split = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: stand.root,
        startRuns: true,
        parentChatId: `qwen:${plainId}`,
        proposal: {
          groups: [
            { title: 'Форма входа', branch: 'feature/login', tasks: [GROUP_TASK] },
            { title: 'Шапка', branch: 'feature/header', tasks: [OTHER_TASK] },
          ],
        },
      },
    });
    check('разделение принято', split.status === 200, split.text.slice(0, 400));
    let group;
    await until(async () => {
      group = (await chats()).find((chat) => chat.title === 'Форма входа');
      return group && group.messageCount >= 2 && (await idle(group.id));
    }, 180);
    check(
      'группа «Форма входа» ответила',
      Boolean(group?.messageCount >= 2),
      JSON.stringify(group),
    );
    const groupBodies = stub.bodies.slice(groupFrom).filter(isGroupOne);
    const first = groupBodies.find(isMain);
    check(
      'ход 1 группы дошёл до модели',
      Boolean(first),
      `запросов: ${stub.bodies.length - groupFrom}`,
    );
    if (!plain || !first || !group) return;

    const groupFound = toolResults(groupBodies);
    check(
      'лёгкий набор на настоящем Qwen: tool_search группы находит трекер, мессенджера нет',
      groupFound.includes(TRACKER_TOOL) && !groupFound.includes(MESSENGER_TOOL),
      groupFound.slice(0, 600) || 'ответов инструментов нет',
    );
    check(
      'инструментов MCP в начале запроса нет ни у обычного разговора, ни у группы',
      [plain, first].every(
        (body) =>
          !JSON.stringify(body).includes(TRACKER_TOOL) &&
          !JSON.stringify(body).includes(MESSENGER_TOOL),
      ),
      'Qwen начал класть инструменты MCP в начало запроса — лёгкий набор теперь укорачивает его, пересмотреть 6.3',
    );

    // Группа правит код — между ходами внутри проекта появляется файл.
    const workdir = (await stand.api(`/provider-chat/chats/${group.id}`)).body?.workdir;
    check('каталог группы известен', Boolean(workdir), String(workdir));
    if (workdir) {
      mkdirSync(join(workdir, 'pkg-05', 'feature'), { recursive: true });
      writeFileSync(join(workdir, 'pkg-05', 'feature', 'edited.ts'), 'export const x = 1;\n');
    }
    const secondFrom = stub.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${group.id}/send`, {
      method: 'POST',
      body: { text: SECOND_WORDS },
    });
    check('ход 2 группы принят', sent.status === 200, sent.text.slice(0, 300));
    await until(() => idle(group.id), 120);
    const second = stub.bodies
      .slice(secondFrom)
      .find((body) => isMain(body) && usersOf(body).includes(SECOND_WORDS));
    check(
      'ход 2 группы дошёл до модели',
      Boolean(second),
      `запросов: ${stub.bodies.length - secondFrom}`,
    );
    if (!second) return;
    check(
      'ход 2: system тот же, байт в байт',
      systemOf(second) === systemOf(first),
      around(systemOf(first), systemOf(second)),
    );
    check(
      'ход 2: tools те же, байт в байт',
      JSON.stringify(toolsOf(second)) === JSON.stringify(toolsOf(first)),
      around(JSON.stringify(toolsOf(first)), JSON.stringify(toolsOf(second))),
    );
    // Сравнение — с ПОСЛЕДНИМ запросом хода 1 (после ответа tool_search): кеш
    // слота держит именно его.
    const last = groupBodies.filter(isMain).at(-1);
    const verdict = tailOnly(last, second);
    check(
      'ход 2 повторяет ход 1 байт в байт; расходится только хвост последней реплики — снятые с неё <system-reminder>',
      verdict.ok && (second.messages?.length ?? 0) > (last.messages?.length ?? 0),
      verdict.detail,
    );
    const whole = (body) =>
      JSON.stringify([systemOf(body), toolsOf(body), (body.messages ?? []).slice(1)]);
    const before = whole(last);
    const after = whole(second);
    let shared = 0;
    while (shared < before.length && before[shared] === after[shared]) shared += 1;
    console.log(
      `    начало запроса группы: system ${systemOf(first).length} знаков, tools ${JSON.stringify(toolsOf(first)).length}; ` +
        `общее начало ходов 1 и 2 — ${shared} из ${before.length} знаков (${Math.round((shared / before.length) * 100)} %)`,
    );

    // Фоновые вызовы модели (6.3): подсказку панель не показывает — её нет ни у
    // кого; память группы (без человека) не ведётся; обычный разговор — как был.
    // Переписка группы называет только свою задачу; обе разом — у родителя, которому
    // панель рассказала о разделении (его память — память разговора человека).
    const ofGroups = (body) =>
      JSON.stringify(body).includes(GROUP_TASK) !== JSON.stringify(body).includes(OTHER_TASK);
    const suggestions = stub.bodies.filter(isSuggestion);
    check(
      'подсказки следующей реплики нет ни у обычного разговора, ни у групп',
      suggestions.length === 0,
      `запросов [SUGGESTION MODE: ${suggestions.length} из ${stub.bodies.length}`,
    );
    const groupMemory = stub.bodies.filter((body) => isMemory(body) && ofGroups(body));
    check(
      'группы без авто-памяти: ни извлечения, ни «сна» по их переписке',
      groupMemory.length === 0,
      `запросов памяти по переписке групп: ${groupMemory.length}`,
    );
    const plainMemory = stub.bodies.filter(
      (body) => isMemory(body) && JSON.stringify(body).includes(PLAIN_WORDS),
    );
    check(
      'контроль: обычный разговор память Qwen ведёт, как вёл',
      plainMemory.length > 0,
      `запросов памяти по обычному разговору нет; всего запросов памяти ${stub.bodies.filter(isMemory).length}`,
    );
    const main = stub.bodies.filter(isMain).length;
    console.log(`    запросов к модели: основных ${main}, прочих ${stub.bodies.length - main}`);

    // 6.4: измеритель находит группы разделения в Qwen по связям панели и
    // считает их по журналам, которые написал сам Qwen.
    const meter = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        fileURLToPath(new URL('../token-audit.mjs', import.meta.url)),
        '--split',
        `qwen:${plainId}`,
        '--config',
        join(stand.home, '.claude'),
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, QWEN_HOME: join(stand.home, '.qwen') } },
    );
    let report;
    try {
      report = JSON.parse(meter.stdout);
    } catch {
      report = undefined;
    }
    const titles = (report?.sessions ?? []).map((session) => session.title ?? '');
    const counted = (title) =>
      (report?.detail ?? []).some((session) => session.title?.includes(title) && session.calls > 0);
    check(
      'pnpm tokens --split: обе группы Qwen посчитаны по своим журналам, родитель — тоже',
      meter.status === 0 && counted('Форма входа') && counted('Шапка') && counted('обычный'),
      `код ${meter.status}; сессии: ${titles.join(' | ') || 'нет'}\n    ${meter.stderr.trim().slice(0, 400)}`,
    );
  },
);
await stub.close();
