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
    settings: { provider: CLI },
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
  },
);
