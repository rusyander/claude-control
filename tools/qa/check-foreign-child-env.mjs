/**
 * Живое доказательство 6.1 плана экономии: ребёнок разделения в чужом CLI
 * получает то же окружение, что ребёнок Claude, — короткий вывод
 * `tests-cli run` (`AGENTDECK_BRIEF_OUTPUT=1`, пункт 2.2) и места очереди
 * тяжёлых шагов (`AGENTDECK_HEAVY_SLOTS` = max(2, ядра/4), как в `ChatRunner.ts`)
 * без потолка vitest, а обычный
 * разговор того же CLI — ничего из этого. Группа ещё и
 * без лишних серверов MCP (1.2): мессенджер и макеты без макета в задачах
 * выключены, трекер остался, а строка о снятых доехала до модели. Выключатель
 * свой у каждого CLI: Codex — ключ `-c mcp_servers.<имя>.enabled=false`, Qwen
 * Code — `mcp.excluded` в слое системных настроек прогона. Рычаг окна сжатия
 * групп (2.1/6.2, `AGENTDECK_GROUP_COMPACT_WINDOW`) включён на стенде: у групп Codex
 * он — `-c model_auto_compact_token_limit`, у разбора и обычного разговора его нет,
 * у Qwen Code — нигде (порога в токенах у него нет).
 *
 * CLI фальшивый, всё до него настоящее: одноразовая панель с активным
 * провайдером, маршрут `POST /api/chat/split` с родителем, связь звена,
 * `ProviderChatService` и запуск процесса. Фальшивка при каждом старте
 * списывает argv, нужные переменные окружения и (Qwen) свой файл настроек.
 *
 * Запуск: `node tools/qa/check-foreign-child-env.mjs [codex|qwen]`; без
 * аргумента — оба по очереди, каждый на своём стенде (так её зовёт блок
 * тестов: аргументов у привязанного скрипта нет). Стенд человека и его
 * конфигурация не трогаются; установленный CLI не нужен.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnStand, wait } from './throwaway-stand.mjs';

const CLI = process.argv[2];
// Мест очереди у ребёнка — по ядрам машины (`ChatRunner.ts CHILD_HEAVY_SLOTS`, 20.10):
// прежнее «ровно 2» краснело на любой машине больше чем с 11 ядрами.
const SLOTS = String(Math.max(2, Math.floor(availableParallelism() / 4)));
if (CLI === undefined) {
  const self = fileURLToPath(import.meta.url);
  const codes = ['codex', 'qwen'].map(
    (cli) => spawnSync(process.execPath, [self, cli], { stdio: 'inherit' }).status ?? 1,
  );
  process.exit(Math.max(...codes));
}
if (CLI !== 'codex' && CLI !== 'qwen') {
  console.error(`Неизвестный CLI «${CLI}»: codex или qwen.`);
  process.exit(2);
}

/**
 * Фальшивый CLI: argv, окружение и снятые серверы — строкой в `calls.jsonl`,
 * ответ — «ок». Строка о снятых ищется там, куда её кладёт панель: в задании
 * (Codex — системного канала нет) или в `QWEN.md` каталога из слоя настроек.
 */
const FAKE_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const LOG = fileURLToPath(import.meta.url).replace(/[^\\/]+$/, 'calls.jsonl');
if (argv[0] === '--version' || argv[0] === '-V') {
  process.stdout.write('${CLI === 'codex' ? 'codex-cli ' : ''}0.160.0\n');
  process.exit(0);
}
const pick = (name) => process.env[name] ?? null;
const NOTE = 'Switched off to save the context';
const file = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
const settings = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const contextFiles = (settings.context?.includeDirectories ?? [])
  .map((dir) => join(dir, 'QWEN.md'))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, 'utf8'));
// Промпт «-» — текст в stdin (так его отдаёт панель Codex), как у настоящего CLI.
const stdin = argv.at(-1) === '-' ? readFileSync(0, 'utf8') : '';
appendFileSync(
  LOG,
  JSON.stringify({
    argv,
    brief: pick('AGENTDECK_BRIEF_OUTPUT'),
    slots: pick('AGENTDECK_HEAVY_SLOTS'),
    workers: pick('VITEST_MAX_WORKERS'),
    compactEnv: pick('AGENTDECK_CODEX_COMPACT_LIMIT'),
    toolOutputEnv: pick('AGENTDECK_CODEX_TOOL_OUTPUT_LIMIT'),
    excluded: settings.mcp?.excluded ?? [],
    threshold: settings.context?.autoCompactThreshold ?? null,
    queueDir: pick('AGENTDECK_HEAVY_QUEUE_DIR'),
    queueHooks: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].filter((event) =>
      (settings.hooks?.[event] ?? []).some((group) =>
        (group.hooks ?? []).some((hook) => String(hook.command).includes('heavy-queue-hook.mjs')),
      ),
    ),
    prompt: stdin.length,
    noted: [argv.join(' '), stdin, ...contextFiles].some((text) => text.includes(NOTE)),
    // Ревью A3: чей это запуск — группа «Форма входа», её второй ход, новая группа.
    login: [argv.join(' '), stdin].some((text) => text.includes('починить валидацию')),
    turn2: [argv.join(' '), stdin].some((text) => text.includes('A3-TURN-2')),
    fresh: [argv.join(' '), stdin].some((text) => text.includes('A3-NEW-GROUP')),
    truncate: settings.tools?.truncateToolOutputThreshold ?? null,
  }) + '\n',
);
// Живую сессию (app-server, serve) фальшивка не ведёт: отказ, и панель идёт одиночным запуском.
if (argv.includes('app-server') || argv.includes('serve')) process.exit(1);
process.stdout.write('ok\n');
process.exit(0);
`;

/** Конфиг CLI в доме стенда: трекер, мессенджер и макеты (имя с точкой). */
const SEED = {
  codex: (home) => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.jira]',
        'command = "node"',
        'args = ["jira-mcp.mjs"]',
        '',
        '[mcp_servers.telegram-inbox]',
        'command = "node"',
        'args = ["telegram.mjs"]',
        '',
        '[mcp_servers."figma.dev"]',
        'url = "https://mcp.figma.com/mcp"',
        '',
      ].join('\n'),
    );
  },
  qwen: (home) => {
    mkdirSync(join(home, '.qwen'), { recursive: true });
    writeFileSync(
      join(home, '.qwen', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          jira: { command: 'node', args: ['jira-mcp.mjs'] },
          'telegram-inbox': { command: 'node', args: ['telegram.mjs'] },
          'figma.dev': { httpUrl: 'https://mcp.figma.com/mcp' },
        },
      }),
    );
  },
};

/** Что выключено у запуска — в словах своего CLI, именами серверов. */
const OFF = {
  codex: (call) =>
    call.argv
      .filter((arg) => /^mcp_servers\..*\.enabled=false$/.test(arg))
      .map((arg) => arg.slice('mcp_servers.'.length, -'.enabled=false'.length))
      .map((key) => (key.startsWith('"') ? JSON.parse(key) : key)),
  qwen: (call) => call.excluded,
};

// Места очереди и потолок vitest, заданные в окружении того, кто запускает
// проверку, панель по замыслу не трогает (`childRunEnv`), — стенд их
// наследовать не должен.
for (const name of ['AGENTDECK_HEAVY_SLOTS', 'VITEST_MAX_WORKERS']) {
  delete process.env[name];
}

await runOnStand(
  {
    label: `foreign-child-env-${CLI}`,
    web: false,
    // Чтение 2000 токенов (пакет C): потолок инструментов Codex ниже его собственного
    // предела 2500 — только так ключ `tool_output_token_limit` вообще появляется.
    settings: {
      provider: CLI,
      ...(CLI === 'codex' ? { groupEconomy: { readOutputTokens: 2000 } } : {}),
    },
    env: { AGENTDECK_GROUP_COMPACT_WINDOW: '160k' },
    fakeCli: { [CLI]: FAKE_CLI },
    // Настоящий CLI человека панель нашла бы раньше обёртки `.cmd`.
    hideCli: [CLI],
    seed: ({ home }) => SEED[CLI](home),
  },
  async (stand, check) => {
    const log = join(stand.bin, 'calls.jsonl');
    const runs = () =>
      (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
        .map((line) => JSON.parse(line))
        .filter((call) => call.argv[0] !== '--version' && call.argv[0] !== '-V')
        .filter((call) => !call.argv.includes('app-server') && !call.argv.includes('serve'));
    const chats = async () => JSON.parse((await stand.api('/provider-chat/chats')).text || '[]');
    /** Ждать, пока у `count` разговоров кончится ход: ответ или отказ записан. */
    const settled = async (count) => {
      for (let t = 0; t < 30_000; t += 250) {
        const done = (await chats()).filter((chat) => chat.messageCount >= 2);
        if (done.length >= count) return done;
        await wait(250);
      }
      return chats();
    };
    // Обёртка стенда зовёт node абсолютным путём — такую панель не узнаёт и идёт
    // через cmd.exe, а многострочное задание группы там отказывается. Обёртка
    // формы npm (`node "%~dp0\…" %*`) панелью разбирается, и argv идёт как есть.
    if (process.platform === 'win32') {
      writeFileSync(join(stand.bin, `${CLI}.cmd`), `@echo off\r\nnode "%~dp0\\${CLI}.mjs" %*\r\n`);
    }
    const brief = (list) =>
      JSON.stringify(list.map(({ argv, ...env }) => ({ cli: argv[0], ...env })));

    // Обычный разговор — не ребёнок.
    const created = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'обычный', workdir: stand.root },
    });
    check(`разговор ${CLI} заведён`, created.status === 200, created.text.slice(0, 300));
    const plainId = JSON.parse(created.text || '{}').id;
    await stand.api(`/provider-chat/chats/${plainId}/send`, {
      method: 'POST',
      body: { text: 'привет' },
    });
    await settled(1);
    const plain = runs();
    // Отказ запуска (ENAMETOOLONG и т. п.) виден ответом разговора, а не логом панели.
    check(
      'обычный разговор: CLI запущен',
      plain.length > 0,
      (await stand.api(`/provider-chat/chats/${plainId}`)).text.slice(0, 1500),
    );
    if (CLI === 'codex') {
      // Набор и задание вместе длиннее командной строки Windows: задание — в stdin.
      check(
        'задание Codex — в stdin («-» последним), не в командной строке',
        plain.length > 0 && plain.every((call) => call.argv.at(-1) === '-' && call.prompt > 0),
        JSON.stringify(plain.map((call) => ({ last: call.argv.at(-1), prompt: call.prompt }))),
      );
    }
    check(
      'обычный разговор: короткого вывода и мест очереди нет',
      plain.length > 0 && plain.every((call) => call.brief === null && call.slots === null),
      brief(plain),
    );

    // Разделение с родителем: разбор и две группы — звенья с связью.
    const split = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: stand.root,
        startRuns: true,
        parentChatId: `${CLI}:${plainId}`,
        proposal: {
          groups: [
            { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
            { title: 'Шапка', branch: 'feature/header', tasks: ['убрать лишний отступ'] },
          ],
        },
      },
    });
    check('разделение принято', split.status === 200, split.text.slice(0, 400));
    const done = await settled(4);
    const kids = runs().slice(plain.length);
    check(
      'разбор и обе группы дошли до CLI',
      done.length >= 4 && kids.length >= 3,
      `разговоров с ходом ${done.length}, запусков ${kids.length}: ${brief(kids)}`,
    );
    check(
      'каждый запуск звена: AGENTDECK_BRIEF_OUTPUT=1',
      kids.length > 0 && kids.every((call) => call.brief === '1'),
      brief(kids),
    );
    check(
      `каждый запуск звена: мест очереди ${SLOTS}, потолка vitest нет`,
      kids.length > 0 && kids.every((call) => call.slots === SLOTS && call.workers === null),
      brief(kids),
    );

    // Лёгкий набор MCP — у групп; разбор не группа, обычный разговор — тоже.
    const off = OFF[CLI];
    const offOf = (list) =>
      JSON.stringify(
        list.map((call) => ({ cli: call.argv[0], off: off(call), noted: call.noted })),
      );
    const groups = kids.filter((call) => off(call).length > 0);
    const rest = [...plain, ...kids.filter((call) => off(call).length === 0)];
    check('обе группы запущены без лишних серверов', groups.length >= 2, offOf(kids));
    check(
      'снят мессенджер и макеты без макета в задачах (имя с точкой), трекер оставлен',
      groups.length > 0 &&
        groups.every(
          (call) =>
            JSON.stringify([...off(call)].sort()) ===
            JSON.stringify(['figma.dev', 'telegram-inbox']),
        ),
      offOf(groups),
    );
    // Очередь тяжёлых шагов (3.2): у групп Qwen Code — хуки оболочки в слое настроек и
    // каталог очереди; у разбора и обычного разговора — нет. У Codex хуки требуют
    // ручного доверия (`/hooks`), и очередь туда не едет вовсе.
    const queueOf = (list) =>
      JSON.stringify(list.map((call) => ({ dir: call.queueDir, hooks: call.queueHooks })));
    if (CLI === 'qwen') {
      check(
        'группы Qwen Code: хуки очереди до, после и при провале оболочки + каталог очереди',
        groups.length > 0 &&
          groups.every((call) => Boolean(call.queueDir) && call.queueHooks.length === 3),
        queueOf(groups),
      );
    }
    check(
      CLI === 'qwen' ? 'разбор и обычный разговор — без очереди' : 'у Codex очереди нет ни у кого',
      (CLI === 'qwen' ? rest : [...plain, ...kids]).every(
        (call) => call.queueDir === null && call.queueHooks.length === 0,
      ),
      queueOf(CLI === 'qwen' ? rest : [...plain, ...kids]),
    );
    if (CLI === 'codex') {
      check(
        'ключ стоит сразу за подкомандой',
        groups.every((call) => call.argv[1] === '-c' && call.argv[2]?.startsWith('mcp_servers.')),
        JSON.stringify(groups.map((call) => call.argv.slice(0, 5))),
      );
    }
    const limited = (call) => call.argv.includes('model_auto_compact_token_limit=160000');
    check(
      CLI === 'codex'
        ? 'порог сжатия 160000 — у групп и только у них'
        : 'порога сжатия нет ни у одного запуска Qwen',
      CLI === 'codex'
        ? groups.length > 0 && groups.every(limited) && rest.every((call) => !limited(call))
        : kids.length > 0 && [...plain, ...kids].every((call) => !limited(call) && !call.threshold),
      JSON.stringify([...plain, ...kids].map((call) => call.argv.filter((a) => a.includes('=')))),
    );
    if (CLI === 'codex') {
      // План экономии чужих CLI (22.10): порог переехал из `runtime.ts` в канал рычагов
      // (`economy-run/codex.ts`) — argv обязан остаться прежним: ключ ровно один, пара
      // `-c` в блоке ключей группы сразу за подкомандой (за снятыми серверами), а
      // служебная переменная до CLI не доходит.
      const LIMIT = 'model_auto_compact_token_limit=160000';
      const placed = (call) => {
        const at = call.argv.indexOf(LIMIT);
        const block = call.argv.slice(1, at + 1);
        return (
          call.argv.filter((arg) => arg.includes('model_auto_compact_token_limit')).length === 1 &&
          block.length % 2 === 0 &&
          block.every((arg, index) =>
            index % 2 === 0 ? arg === '-c' : arg === LIMIT || arg.startsWith('mcp_servers.'),
          )
        );
      };
      check(
        'порог Codex: та же пара `-c` в блоке группы за подкомандой, ровно один раз',
        groups.length > 0 && groups.every(placed),
        JSON.stringify(groups.map((call) => call.argv.slice(0, 9))),
      );
      check(
        'служебная AGENTDECK_CODEX_COMPACT_LIMIT до CLI не доходит',
        [...plain, ...kids].every((call) => call.compactEnv === null),
        JSON.stringify([...plain, ...kids].map((call) => call.compactEnv)),
      );
      // Пакет C (решение O2): потолок ответа инструмента — один ключ на все инструменты,
      // max(ceil(8000 / 4), 2000) = 2000 при чтении 2000 на стенде (ниже предела Codex
      // 2500 — иначе ключа нет); пара `-c` сразу за порогом сжатия, у разбора и обычного
      // разговора её нет.
      const TOOL = 'tool_output_token_limit=2000';
      const toolPlaced = (call) => {
        const at = call.argv.indexOf(TOOL);
        return (
          call.argv.filter((arg) => arg.includes('tool_output_token_limit')).length === 1 &&
          call.argv[at - 1] === '-c' &&
          call.argv[at - 2] === LIMIT
        );
      };
      check(
        'потолок инструментов Codex 2000 — у групп за порогом сжатия, ровно один раз',
        groups.length > 0 && groups.every(toolPlaced),
        JSON.stringify(groups.map((call) => call.argv.slice(0, 11))),
      );
      check(
        'потолка инструментов нет у разбора и обычного разговора',
        rest.every((call) => !call.argv.some((arg) => arg.includes('tool_output_token_limit'))),
        JSON.stringify(rest.map((call) => call.argv.filter((a) => a.includes('=')))),
      );
      check(
        'служебная AGENTDECK_CODEX_TOOL_OUTPUT_LIMIT до CLI не доходит',
        [...plain, ...kids].every((call) => call.toolOutputEnv === null),
        JSON.stringify([...plain, ...kids].map((call) => call.toolOutputEnv)),
      );
    }
    check(
      'разбор и обычный разговор — с полным набором',
      kids.length - groups.length >= 1 && plain.every((call) => off(call).length === 0),
      offOf([...plain, ...kids]),
    );
    check(
      'строка о снятых серверах доехала до групп и только до них',
      groups.length > 0 && groups.every((call) => call.noted) && rest.every((call) => !call.noted),
      offOf([...plain, ...kids]),
    );

    // Ревью A3: рычаги закрепляются на первом старте разговора группы. Правка
    // настройки между ходами не меняет второй ход той же группы, а новая группа
    // (второе разделение) берёт новое значение. Codex: потолок инструментов
    // max(ceil(9600 / 4), 2000) = 2400 — ниже предела 2500, ключ есть; Qwen Code —
    // `tools.truncateToolOutputThreshold` слоя настроек в знаках.
    const economyOf = (call) => ({
      tool: call.argv.filter((arg) => arg.includes('tool_output_token_limit')),
      truncate: call.truncate,
      brief: call.brief,
      slots: call.slots,
      off: off(call),
      compact: call.argv.filter((arg) => arg.includes('model_auto_compact_token_limit')),
    });
    const turn1 = groups.find((call) => call.login);
    check(
      CLI === 'codex'
        ? 'первый ход «Формы входа»: потолок инструментов 2000'
        : 'первый ход «Формы входа»: предел вывода 8000 знаков',
      CLI === 'codex'
        ? turn1?.argv.includes('tool_output_token_limit=2000') === true
        : turn1?.truncate === 8000,
      JSON.stringify(turn1 ? economyOf(turn1) : groups.map(economyOf)),
    );
    const patched = await stand.api('/settings', {
      method: 'PATCH',
      body: {
        groupEconomy: {
          bashOutputChars: 9600,
          ...(CLI === 'codex' ? { readOutputTokens: 2000 } : {}),
        },
      },
    });
    check(
      'настройка рычагов изменена между ходами',
      patched.status === 200,
      patched.text.slice(0, 300),
    );
    const login = (await chats()).find((chat) => chat.title === 'Форма входа');
    check('разговор группы «Форма входа» найден', Boolean(login), JSON.stringify(await chats()));
    const beforeTurn2 = runs().length;
    if (login) {
      await stand.api(`/provider-chat/chats/${login.id}/send`, {
        method: 'POST',
        body: { text: 'A3-TURN-2: продолжай' },
      });
      for (let t = 0; t < 30_000 && !runs().some((call) => call.turn2); t += 250) await wait(250);
    }
    const turn2 = runs()
      .slice(beforeTurn2)
      .find((call) => call.turn2);
    check(
      'второй ход той же группы — с рычагами первого хода',
      Boolean(turn1 && turn2) &&
        JSON.stringify(economyOf(turn2)) === JSON.stringify(economyOf(turn1)),
      JSON.stringify({
        turn1: turn1 && economyOf(turn1),
        turn2: turn2 && economyOf(turn2),
      }),
    );

    // Новая группа — второе разделение от второго обычного разговора.
    const second = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'второй', workdir: stand.root },
    });
    const secondId = JSON.parse(second.text || '{}').id;
    await stand.api(`/provider-chat/chats/${secondId}/send`, {
      method: 'POST',
      body: { text: 'привет' },
    });
    for (let t = 0; t < 30_000; t += 250) {
      if ((await chats()).find((chat) => chat.id === secondId)?.messageCount >= 2) break;
      await wait(250);
    }
    const beforeFresh = runs().length;
    const split2 = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: stand.root,
        startRuns: true,
        parentChatId: `${CLI}:${secondId}`,
        proposal: {
          groups: [
            {
              title: 'Подвал',
              branch: 'feature/footer',
              tasks: ['A3-NEW-GROUP: поправить подвал'],
            },
            // Разделение — минимум две группы с задачами.
            { title: 'Меню', branch: 'feature/menu', tasks: ['A3-NEW-GROUP: сузить меню'] },
          ],
        },
      },
    });
    check('второе разделение принято', split2.status === 200, split2.text.slice(0, 400));
    const freshGroup = () =>
      runs()
        .slice(beforeFresh)
        .find((call) => call.fresh && off(call).length > 0);
    for (let t = 0; t < 30_000 && !freshGroup(); t += 250) await wait(250);
    const fresh = freshGroup();
    check(
      CLI === 'codex'
        ? 'новая группа — с новым потолком инструментов 2400, ровно один раз'
        : 'новая группа — с новым пределом вывода 9600 знаков',
      CLI === 'codex'
        ? fresh?.argv.filter((arg) => arg.includes('tool_output_token_limit')).join() ===
            'tool_output_token_limit=2400'
        : fresh?.truncate === 9600,
      JSON.stringify(fresh ? economyOf(fresh) : runs().slice(beforeFresh).map(economyOf)),
    );
  },
);
