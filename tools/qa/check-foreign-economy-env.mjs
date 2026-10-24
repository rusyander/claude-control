/**
 * Живое доказательство пакета D плана экономии чужих CLI: рычаги групп Goose и
 * Continue доходят до запуска CLI переменными окружения, а Gemini — ничем.
 *
 * - Goose: `GOOSE_AUTO_COMPACT_THRESHOLD` = окно группы / окно, которое знает сам
 *   Goose (здесь `GOOSE_CONTEXT_LIMIT: 400000` в его `config.yaml` стенда → 160k /
 *   400k = 0.4; само окно тогда не переписывается), и `GOOSE_MAX_TOOL_RESPONSE_SIZE`
 *   = max(вывод оболочки, чтение × 4) знаков (6000 и 3000 → 12000).
 * - Continue (`cn`): `CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS` = 6000 и
 *   `CONTINUE_CLI_READ_FILE_MAX_OUTPUT_CHARS` = 3000 × 4 = 12000.
 * - Gemini: файл системных настроек CLI на прогон отвергает (проба 0.65.0: «not
 *   owned by a trusted administrator») — канала нет, ни `GEMINI_CLI_SYSTEM_SETTINGS_PATH`,
 *   ни `GEMINI_CLI_HOME`.
 *
 * - Goose без своего окна (`goose-catalog`): окно облачной модели хода — по каталогу
 *   моделей панели (ревью D, F1). В `config.yaml` стенда только провайдер `anthropic`
 *   и модель `claude-sonnet-4.5` (точка версии, в каталоге — дефис), в кэше каталога
 *   стенда окно 200000 → доля 160k / 200k = 0.8, и окно передаётся явно.
 *
 * - Строка экономии группы в задании: у каждого CLI — целиком, у aider (один
 *   `--message`, без своих инструментов) — только тетрадь задачи и задачи трекера;
 *   переменных рычагов у aider нет.
 *
 * У разбора (triage) и обычного разговора того же CLI — ничего из этого.
 *
 * CLI фальшивый, всё до него настоящее: одноразовая панель с активным
 * провайдером, маршрут `POST /api/chat/split` с родителем, связь звена,
 * `ProviderChatService`, канал рычагов из каталога и запуск процесса. Фальшивка
 * при каждом старте списывает argv-признак группы и нужные переменные.
 *
 * Запуск: `node tools/qa/check-foreign-economy-env.mjs [goose|goose-catalog|continue|gemini|aider]`;
 * без аргумента — все пять по очереди, каждый на своём стенде. Стенд человека и его
 * конфигурация не трогаются; установленный CLI не нужен.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnStand, wait } from './throwaway-stand.mjs';

const PROVIDERS = {
  goose: 'goose',
  'goose-catalog': 'goose',
  continue: 'cn',
  gemini: 'gemini',
  aider: 'aider',
};
/** Ключ запуска → провайдер панели (`goose-catalog` — тот же Goose, другой конфиг). */
const PROVIDER_ID = {
  goose: 'goose',
  'goose-catalog': 'goose',
  continue: 'continue',
  gemini: 'gemini',
  aider: 'aider',
};
const CLI = process.argv[2];
if (CLI === undefined) {
  const self = fileURLToPath(import.meta.url);
  const codes = Object.keys(PROVIDERS).map(
    (cli) => spawnSync(process.execPath, [self, cli], { stdio: 'inherit' }).status ?? 1,
  );
  process.exit(Math.max(...codes));
}
if (!(CLI in PROVIDERS)) {
  console.error(`Неизвестный CLI «${CLI}»: ${Object.keys(PROVIDERS).join(', ')}.`);
  process.exit(2);
}
const COMMAND = PROVIDERS[CLI];
const PROVIDER = PROVIDER_ID[CLI];
/**
 * Строка экономии группы, которую CLI обязан получить: целиком, а aider (один
 * `--message`, без своих инструментов) — только тетрадь задачи и задачи трекера.
 */
const ECONOMY_LINE = CLI === 'aider' ? 'notes' : 'full';

/** Переменные, которые списывает фальшивка: рычаги и то, чего у Gemini быть не должно. */
const WATCHED = [
  'GOOSE_AUTO_COMPACT_THRESHOLD',
  'GOOSE_CONTEXT_LIMIT',
  'GOOSE_MAX_TOOL_RESPONSE_SIZE',
  'GOOSE_CACHE_TTL',
  'CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS',
  'CONTINUE_CLI_READ_FILE_MAX_OUTPUT_CHARS',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'GEMINI_CLI_HOME',
];

/**
 * Фальшивый CLI: признак группы (её вводная в задании), подкоманда и переменные —
 * строкой в `calls.jsonl`, ответ — «ок». Живой сервер (`goose acp`) фальшивка не
 * ведёт: списывает его окружение и отказывает, панель идёт одиночным запуском.
 */
const FAKE_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const LOG = fileURLToPath(import.meta.url).replace(/[^\\/]+$/, 'calls.jsonl');
if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === '-v') {
  process.stdout.write('1.54.0\n');
  process.exit(0);
}
const WATCHED = ${JSON.stringify(WATCHED)};
const env = Object.fromEntries(WATCHED.map((name) => [name, process.env[name] ?? null]));
// Вводная группы может ехать и файлом системной строки (путь в окружении).
const files = Object.values(process.env)
  .filter((value) => typeof value === 'string' && value.length < 400 && /\.(md|txt|json)$/i.test(value))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, 'utf8'));
const live = argv[0] === 'acp';
const text = [argv.join(' '), ...files].join('\n');
appendFileSync(
  LOG,
  JSON.stringify({
    live,
    group: text.includes('You are a split group'),
    // Какая строка экономии группы доехала: целиком, только тетрадь (CLI без цикла
    // инструментов) или никакой.
    economy: text.includes('batch independent reads')
      ? 'full'
      : text.includes('Each fact you had to find out')
        ? 'notes'
        : null,
    ...env,
  }) + '\n',
);
if (live) process.exit(1);
process.stdout.write('ok\n');
process.exit(0);
`;

/** Конфиг Goose стенда: окно, которое знает сам Goose. Остальным CLI конфиг не нужен. */
function seedGoose(home, yaml = 'GOOSE_CONTEXT_LIMIT: 400000\n') {
  const dir =
    process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config')
      : join(home, '.config', 'goose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), yaml);
}

/**
 * Goose без своего окна: провайдер и модель в `config.yaml`, окно — только в кэше
 * каталога моделей панели (`models-cache.json` в её каталоге данных; сеть стенду не нужна).
 */
function seedGooseCatalog({ home, cfg }) {
  seedGoose(home, 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4.5\n');
  const data = join(cfg, 'agentdeck');
  mkdirSync(data, { recursive: true });
  const model = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    vendor: 'anthropic',
    contextLimit: 200000,
  };
  writeFileSync(
    join(data, 'models-cache.json'),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      url: 'https://models.dev/api.json',
      models: [model],
      knownIds: [model.id],
      newIds: [],
    }),
  );
}

/** Что рычаги обязаны дать группе — и ровно это; у прочих запусков — пусто. */
const EXPECTED = {
  goose: { GOOSE_AUTO_COMPACT_THRESHOLD: '0.4', GOOSE_MAX_TOOL_RESPONSE_SIZE: '12000' },
  'goose-catalog': {
    GOOSE_AUTO_COMPACT_THRESHOLD: '0.8',
    GOOSE_CONTEXT_LIMIT: '200000',
    GOOSE_MAX_TOOL_RESPONSE_SIZE: '12000',
  },
  continue: {
    CONTINUE_CLI_BASH_MAX_OUTPUT_CHARS: '6000',
    CONTINUE_CLI_READ_FILE_MAX_OUTPUT_CHARS: '12000',
  },
  gemini: {},
  aider: {},
}[CLI];
const levers = (call) =>
  Object.fromEntries(
    WATCHED.filter((name) => call[name] !== null).map((name) => [name, call[name]]),
  );

await runOnStand(
  {
    label: `foreign-economy-env-${CLI}`,
    web: false,
    settings: {
      provider: PROVIDER,
      groupEconomy: { bashOutputChars: 6000, readOutputTokens: 3000, cacheTtl: '1h' },
    },
    env: { AGENTDECK_GROUP_COMPACT_WINDOW: '160k' },
    fakeCli: { [COMMAND]: FAKE_CLI },
    // Настоящий CLI человека панель нашла бы раньше обёртки `.cmd`.
    hideCli: [COMMAND],
    seed: (dirs) =>
      CLI === 'goose'
        ? seedGoose(dirs.home)
        : CLI === 'goose-catalog'
          ? seedGooseCatalog(dirs)
          : undefined,
  },
  async (stand, check) => {
    const log = join(stand.bin, 'calls.jsonl');
    const calls = () =>
      (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []).map((line) =>
        JSON.parse(line),
      );
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
    // через cmd.exe, где многострочное задание группы отказывается. Обёртка формы
    // npm (`node "%~dp0\…" %*`) панелью разбирается, и argv идёт как есть.
    if (process.platform === 'win32') {
      writeFileSync(
        join(stand.bin, `${COMMAND}.cmd`),
        `@echo off\r\nnode "%~dp0\\${COMMAND}.mjs" %*\r\n`,
      );
    }
    const show = (list) =>
      JSON.stringify(list.map((call) => ({ ...levers(call), live: call.live, group: call.group })));

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
    const plain = calls();
    check(
      'обычный разговор: CLI запущен',
      plain.some((call) => !call.live),
      (await stand.api(`/provider-chat/chats/${plainId}`)).text.slice(0, 1500),
    );
    check(
      'обычный разговор: рычагов нет',
      plain.every((call) => Object.keys(levers(call)).length === 0),
      show(plain),
    );

    // Разделение с родителем: разбор и две группы.
    const split = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: stand.root,
        startRuns: true,
        parentChatId: `${PROVIDER}:${plainId}`,
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
    const kids = calls().slice(plain.length);
    const runs = kids.filter((call) => !call.live);
    const groups = runs.filter((call) => call.group);
    const triage = runs.filter((call) => !call.group);
    check(
      'разбор и обе группы дошли до CLI',
      done.length >= 4 && groups.length >= 2 && triage.length >= 1,
      `разговоров с ходом ${done.length}: ${show(kids)}`,
    );
    const expected = JSON.stringify(EXPECTED);
    check(
      ECONOMY_LINE === 'notes'
        ? `группы ${CLI}: из строки экономии — только тетрадь и задачи трекера`
        : `группы ${CLI}: строка экономии целиком`,
      groups.length >= 2 && groups.every((call) => call.economy === ECONOMY_LINE),
      JSON.stringify(groups.map((call) => call.economy)),
    );
    check(
      'обычный разговор и разбор: строки экономии группы нет',
      [...plain, ...triage].every((call) => call.economy === null),
      JSON.stringify([...plain, ...triage].map((call) => call.economy)),
    );
    check(
      Object.keys(EXPECTED).length === 0
        ? `группы ${CLI}: ни одной переменной рычагов и слоя настроек`
        : `группы ${CLI}: ровно ${expected}`,
      groups.length >= 2 && groups.every((call) => JSON.stringify(levers(call)) === expected),
      show(groups),
    );
    check(
      'разбор: рычагов нет',
      triage.every((call) => Object.keys(levers(call)).length === 0),
      show(triage),
    );
    // Живой сервер (`goose acp`) задания в argv не несёт — чей он, видно только по
    // счёту: по одному на каждое звено, у групп те же рычаги, у разбора — ничего.
    const liveKids = kids.filter((call) => call.live);
    const liveWith = liveKids.filter((call) => JSON.stringify(levers(call)) === expected);
    const liveBare = liveKids.filter((call) => Object.keys(levers(call)).length === 0);
    if (PROVIDER === 'goose') {
      check(
        'живой `goose acp`: у двух групп те же рычаги, у разбора — ничего',
        liveKids.length === groups.length + triage.length &&
          liveWith.length === groups.length &&
          liveBare.length === triage.length,
        `${liveKids.length} запусков: ${show(liveKids)}`,
      );
    } else {
      check('живого сервера нет', liveKids.length === 0, show(liveKids));
    }
    check(
      'срок кэша 1h до CLI не доходит (у Goose — проба: запрос не меняется)',
      [...plain, ...kids].every((call) => call.GOOSE_CACHE_TTL === null),
      show([...plain, ...kids]),
    );
  },
);
