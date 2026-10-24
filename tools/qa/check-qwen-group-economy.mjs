/**
 * Живое доказательство рычагов экономии групп у Qwen Code (план экономии чужих
 * CLI, пакет B): доходят ли рычаги страницы «Настройки → Группы» до настоящего
 * `qwen serve` одним слоем системных настроек на прогон, и что Qwen с ними делает.
 *
 * Настоящие панель (одноразовый стенд) и `qwen`; подменена только модель
 * (заглушка OpenAI chat пишет тела запросов и сама зовёт инструменты). Свидетель —
 * тела запросов к модели и файл слоя:
 * - группа «Форма входа» и обычный разговор (контроль — у него рычагов нет);
 * - ход 1: оболочка печатает 20 000 знаков. Группа получает ответ, урезанный
 *   пределом рычага (5000), обычный разговор — целиком, хотя в личных настройках
 *   человека стоит 50 000: системный слой группы главнее личного файла;
 * - ход 2: `read_file` файла в 20 000 знаков — у группы урезан тем же пределом
 *   (решение O2: у Qwen один предел на все инструменты), у разговора — целиком;
 * - сжатие: заглушка сообщает 130 000 токенов запроса. Окно модели в каталоге
 *   панели — 200 000, окно группы — 100 000, доля 0.5: перед ходом 2 группа просит
 *   модель о сжатии (`<state_snapshot>`), обычный разговор (порог Qwen ~167 000) — нет;
 * - системные настройки человека (`QWEN_CODE_SYSTEM_SETTINGS_PATH` стенда, своя
 *   температура 0.123) доходят до модели у обоих: слой ложится поверх, не вместо;
 * - срок кэша '1h' включён, а вход — OpenAI-совместимый: ключа срока в слое нет.
 *
 * CLI — из `STEER_CLI_DIR`, иначе из PATH. Нет CLI — «не проверено», код 2. Дом
 * Qwen — дом стенда; `~/.qwen` и `~/.claude` человека не трогаются.
 * `QWEN_ECONOMY_DUMP=<файл>` — тела всех запросов в файл для разбора.
 *
 * Запуск: node tools/qa/check-qwen-group-economy.mjs
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const PLAIN_WORDS = 'PLAIN-ECONOMY-p1';
const GROUP_TASK = 'починить валидацию';
const OTHER_TASK = 'убрать лишний отступ';
const SECOND_WORDS = 'SECOND-ECONOMY-t2';
const BIG = 20_000;
const LIMIT = 5_000;
const COMPRESS = '<state_snapshot>';
const TEMPERATURE = 0.123;
const BIG_FILE = 'economy-big.txt';

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
const toolNames = (body) => (body?.tools ?? []).map((tool) => tool.function?.name);
const systemOf = (body) => ofRole(body, 'system').join('\n');
/**
 * Просьба о сжатии: Qwen 0.24 шлёт её дважды — запросом с историей хода и
 * просьбой о сводке последним сообщением, и отдельным запросом-сводчиком. Оба
 * кончаются сообщением человека с `<state_snapshot>`; ход после сжатия несёт
 * сводку в начале истории, а не в конце, — он не просьба.
 */
const isCompression = (body) => {
  const last = (body?.messages ?? []).at(-1);
  return last?.role === 'user' && text(last.content).includes(COMPRESS);
};
/**
 * Основной запрос хода: с инструментами CLI, не подсказка, не сжатие и не
 * фоновый разбор памяти (свой системный текст, те же маркеры в истории).
 */
const isMain = (body) =>
  toolNames(body).includes('run_shell_command') &&
  !isCompression(body) &&
  !/memory extraction/i.test(systemOf(body)) &&
  !(ofRole(body, 'user').at(-1) ?? '').trimStart().startsWith('[SUGGESTION MODE');
/**
 * Чей запрос. Группа несёт вводную с разговором-родителем (`PLAIN_WORDS`), а
 * вводная разделения — задачи обеих групп, поэтому «группа» = своя задача без
 * чужой, «обычный» = его слова без задач групп. Разделение и вторая группа —
 * ничьи. Сводка заглушки повторяет задачу группы: история после сжатия
 * остаётся узнаваемой.
 */
function whoseOf(body) {
  const users = usersOf(body);
  const group = users.includes(GROUP_TASK);
  const other = users.includes(OTHER_TASK);
  if (group && !other) return 'group';
  if (users.includes(PLAIN_WORDS) && !group && !other) return 'plain';
  return '';
}
/** Ответ инструмента по id вызова — последнее, что видела модель. */
function toolResult(bodies, callId) {
  for (const body of [...bodies].reverse()) {
    const found = (body.messages ?? []).find(
      (message) => message.role === 'tool' && message.tool_call_id === callId,
    );
    if (found) return text(found.content);
  }
  return undefined;
}

/**
 * Заглушка OpenAI chat. Ход без ответа инструмента: первый — оболочка на 20 000
 * знаков, второй (`SECOND_WORDS`) — `read_file` файла, путь которого проверка
 * выставляет перед ходом. Запрос сжатия — сводка `<state_snapshot>`. Итоговый
 * ответ хода сообщает 130 000 токенов запроса — повод для сжатия только у группы.
 */
async function startStub() {
  const bodies = [];
  const readPath = { plain: '', group: '' };
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
      if (process.env.QWEN_ECONOMY_DUMP) {
        writeFileSync(process.env.QWEN_ECONOMY_DUMP, JSON.stringify(bodies, null, 1));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (extra) =>
        res.write(
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'stub-model', ...extra })}\n\n`,
        );
      const last = (body.messages ?? []).at(-1);
      const whose = whoseOf(body);
      // 130 000 токенов — только у итогового ответа хода: сжатие тогда случается в
      // начале следующего хода, и ответ инструмента первого хода до модели доходит.
      const tokens = isMain(body) && last?.role === 'tool' ? 130_000 : 1_000;
      const usage = { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 };
      let call;
      if (isMain(body) && last?.role !== 'tool' && whose) {
        call = usersOf(body).includes(SECOND_WORDS)
          ? { name: 'read_file', arguments: JSON.stringify({ file_path: readPath[whose] }) }
          : {
              name: 'run_shell_command',
              arguments: JSON.stringify({
                command: `node -e "process.stdout.write('y'.repeat(${BIG}))"`,
                description: 'big output',
              }),
            };
      }
      if (call) {
        const id = `call_${whose}_${call.name}_${bodies.length}`;
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id, type: 'function', function: call }],
              },
              finish_reason: null,
            },
          ],
        });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
      } else {
        const answer = isCompression(body)
          ? `<analysis>a</analysis><state_snapshot><overall_goal>stub ${whose === 'group' ? GROUP_TASK : ''}</overall_goal></state_snapshot>`
          : 'OK';
        chunk({
          choices: [
            { index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null },
          ],
        });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    bodies,
    readPath,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const bigFile = () =>
  Array.from({ length: BIG / 50 }, (_, i) => `L${String(i).padStart(4, '0')}`.padEnd(49, 'r')).join(
    '\n',
  ) + '\n';

/** Все файлы слоя экономии стенда — в корне `qwen-economy-layers` каталога данных панели. */
function economyLayers(cfg) {
  const root = join(cfg, 'agentdeck', 'qwen-economy-layers');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(root, name, 'system-settings.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')));
}

console.log('Qwen: рычаги экономии групп на настоящем qwen serve');
const dir = findCli('qwen');
if (!dir) {
  console.log('  Не проверено: «qwen» нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const stub = await startStub();
for (const name of ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']) {
  delete process.env[name];
}
let machineSettings = '';

await runOnStand(
  {
    label: 'qwen-group-economy',
    web: false,
    settings: {
      provider: 'qwen',
      groupEconomy: { compactWindow: 100_000, bashOutputChars: LIMIT, cacheTtl: '1h' },
    },
    extraPath: [dir],
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
      OPENAI_API_KEY: 'x',
      OPENAI_MODEL: 'stub-model',
      // Файл системных настроек «машины» — свой у стенда, настоящий не читается.
      get QWEN_CODE_SYSTEM_SETTINGS_PATH() {
        return machineSettings;
      },
    },
    seed: ({ root, home, cfg }) => {
      machineSettings = join(root, 'machine-settings.json');
      writeFileSync(
        machineSettings,
        JSON.stringify({
          model: { generationConfig: { samplingParams: { temperature: TEMPERATURE } } },
        }),
      );
      mkdirSync(join(home, '.qwen'), { recursive: true });
      // Личный предел человека выше рычага: у группы его перекрывает системный слой.
      writeFileSync(
        join(home, '.qwen', 'settings.json'),
        JSON.stringify({ tools: { truncateToolOutputThreshold: 50_000 } }),
      );
      // Каталог моделей панели: окно облачной модели — отсюда.
      mkdirSync(join(cfg, 'agentdeck'), { recursive: true });
      writeFileSync(
        join(cfg, 'agentdeck', 'models-cache.json'),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          url: 'https://models.dev/api.json',
          models: [
            {
              id: 'stub-model',
              name: 'stub-model',
              family: 'qwen',
              vendor: 'alibaba',
              contextLimit: 200_000,
            },
          ],
          knownIds: ['stub-model'],
          newIds: [],
        }),
      );
      writeFileSync(join(root, BIG_FILE), bigFile());
    },
  },
  async (stand, check) => {
    if (!machineSettings) throw new NotChecked('файл системных настроек стенда не записан');
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
    const send = async (id, words) => {
      const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text: words },
      });
      await until(() => idle(id), 180);
      return sent;
    };
    const ofWhose = (whose) => stub.bodies.filter((body) => whoseOf(body) === whose);
    const resultOf = (whose, tool) => {
      const bodies = ofWhose(whose);
      const ids = bodies.flatMap((body) =>
        (body.messages ?? []).flatMap((message) =>
          (message.tool_calls ?? [])
            .filter((call) => call.function?.name === tool)
            .map((call) => call.id),
        ),
      );
      const id = ids.at(-1);
      return id ? toolResult(bodies, id) : undefined;
    };

    // Обычный разговор — контроль: у него рычагов группы нет.
    const created = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'обычный', workdir: stand.root },
    });
    check('обычный разговор заведён', created.status === 200, created.text.slice(0, 300));
    const plainId = created.body?.id;
    // Правки разрешены: иначе оболочка ждала бы «да» человека карточкой в чате.
    await stand.api(`/provider-chat/chats/${plainId}`, {
      method: 'PATCH',
      body: { allowEdits: true },
    });
    stub.readPath.plain = join(stand.root, BIG_FILE);
    await send(plainId, PLAIN_WORDS);

    const split = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: stand.root,
        startRuns: true,
        parentChatId: `qwen:${plainId}`,
        // Модель группе не назначается (у Qwen нет лестницы): окно — по своей модели
        // CLI, `OPENAI_MODEL` стенда.
        allowEdits: true,
        proposal: {
          // Разбор принимает минимум две группы; вторая отвечает «OK» и делит слой первой.
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
    check('группа ответила на ход 1', Boolean(group?.messageCount >= 2), JSON.stringify(group));
    if (!group) return;

    // Слой экономии: что панель положила в файл системных настроек группы.
    const layers = economyLayers(stand.cfg);
    const layer = layers.at(-1);
    check('слой экономии группы записан (один)', layers.length === 1, `слоёв: ${layers.length}`);
    check(
      'в слое: предел инструментов = рычаг вывода оболочки, доля окна 0.5, редактор выключен',
      layer?.tools?.truncateToolOutputThreshold === LIMIT &&
        layer?.context?.autoCompactThreshold === 0.5 &&
        layer?.ide?.enabled === false,
      JSON.stringify(layer),
    );
    check(
      'срок кэша 1h при входе OpenAI в слой не попал',
      layer?.model?.generationConfig?.cacheRetention === undefined,
      JSON.stringify(layer?.model),
    );

    // Ход 1: оболочка на 20 000 знаков.
    const groupShell = resultOf('group', 'run_shell_command') ?? '';
    const plainShell = resultOf('plain', 'run_shell_command') ?? '';
    check(
      `группа: ответ оболочки урезан пределом рычага (≤ ${LIMIT + 1000} знаков)`,
      groupShell.length > 0 && groupShell.length <= LIMIT + 1000 && /truncated/i.test(groupShell),
      `длина ${groupShell.length}: ${groupShell.slice(0, 200)}`,
    );
    check(
      'контроль: обычный разговор получил вывод оболочки целиком (личный предел 50 000)',
      plainShell.includes('y'.repeat(BIG)),
      `длина ${plainShell.length}`,
    );

    // Ход 2: чтение файла на 20 000 знаков — и сжатие у группы перед ним.
    const workdir = (await stand.api(`/provider-chat/chats/${group.id}`)).body?.workdir;
    check('каталог группы известен', Boolean(workdir), String(workdir));
    if (!workdir) return;
    writeFileSync(join(workdir, BIG_FILE), bigFile());
    stub.readPath.group = join(workdir, BIG_FILE);
    await send(group.id, SECOND_WORDS);
    await send(plainId, SECOND_WORDS);

    const groupRead = resultOf('group', 'read_file') ?? '';
    const plainRead = resultOf('plain', 'read_file') ?? '';
    check(
      `O2: read_file группы режется тем же пределом (≤ ${LIMIT + 1000} знаков)`,
      groupRead.length > 0 && groupRead.length <= LIMIT + 1000,
      `длина ${groupRead.length}: ${groupRead.slice(0, 200)}`,
    );
    check(
      'контроль: read_file обычного разговора — весь файл',
      plainRead.includes('L0399'),
      `длина ${plainRead.length}`,
    );
    const compressions = (whose) =>
      stub.bodies.filter((body) => isCompression(body) && whoseOf(body) === whose).length;
    check(
      'группа попросила модель о сжатии: 130 000 токенов > доли 0.5 окна 200 000',
      compressions('group') > 0,
      `запросов сжатия группы: ${compressions('group')}`,
    );
    check(
      'контроль: обычный разговор сжатия не просил (порог Qwen по умолчанию ~167 000)',
      compressions('plain') === 0,
      `запросов сжатия обычного разговора: ${compressions('plain')}`,
    );

    // Системные настройки человека — под слоем, а не вместо него.
    const temperatures = (whose) =>
      ofWhose(whose)
        .filter(isMain)
        .map((body) => body.temperature);
    check(
      `системные настройки человека дошли: температура ${TEMPERATURE} у группы и у разговора`,
      ['group', 'plain'].every(
        (whose) =>
          temperatures(whose).length > 0 && temperatures(whose).every((t) => t === TEMPERATURE),
      ),
      JSON.stringify({ group: temperatures('group'), plain: temperatures('plain') }),
    );
    check(
      'слой экономии один на разговор: ход 2 не завёл второго',
      economyLayers(stand.cfg).length === 1,
      `слоёв: ${economyLayers(stand.cfg).length}`,
    );
    console.log(`    запросов к модели: ${stub.bodies.length}`);
  },
);
await stub.close();
