/**
 * Контур у чата чужого CLI (X7): НАСТОЯЩИЕ Goose и OpenCode задачей ядра `chat@1` →
 * шлюз контура ядра → стаб-контур.
 *
 * Чат чужого CLI — задача ядра (этап 10, F2c): сервер заводит её тем же стартером, что
 * продолжение и перенос (`startCoreForeignChat`), а галочка `foreign:<cli>` активного контура —
 * разрешённый набор задачи (`coreContourRoutes` → `set-route` до запуска). Обещание человеку —
 * «с галочкой ни один запрос не уходит провайдером из твоего конфига», и проверить его можно
 * только настоящим CLI: таблицы решают маршрут, но не знают, послушается ли его сам CLI.
 *
 * Подменено только то, что над панелью и ядром: контур (`stub-platform.mjs`) и «облако
 * человека» — вторая заглушка, на которую смотрит конфиг каждого CLI. Дом, конфиги и данные CLI —
 * во временных каталогах (`APPDATA`/`HOME`, `XDG_*`); настоящие `%APPDATA%\Block\goose`,
 * `~/.config/opencode` не читаются и не пишутся. Ядро, хост звеньев, шлюз и сеанс CLI — код ядра,
 * настоящий; стартер и маршрут контура — код панели. `GOOSE_DISABLE_KEYRING` — чтобы Goose не
 * трогал связку ключей ОС.
 *
 * Для каждого CLI:
 *   1. галочка стоит — ответ контура в ленте сеанса; наверх ушёл только `chat/completions` с
 *      ключом контура; след шлюза есть; облако человека не получило НИ ОДНОГО запроса;
 *   2. галочка снята при обязательном контуре — всё равно маршрут контура с моделью контура
 *      (решение 02.11): ответ контура, наверх только контур, облако человека пусто;
 *   2б. галочка снята при «по возможности» — маршрута у задачи нет: у Goose, OpenCode и Gemini
 *      нет маршрута входа CLI (`cliLogin: false` — сеанс ядра конфиг человека не читает), ядро
 *      отказывает до процесса, и ни контур, ни облако человека запроса не видят. Прежний контроль
 *      «без галочки CLI идёт в облако человека» был правдой исполнителя панели, которого больше нет;
 *   3. настройка конфига человека, уводящая часть прогона мимо контура (Goose
 *      `GOOSE_LEAD_PROVIDER`; Gemini — `.env` с адресом и ключом облака человека в доме и в
 *      каталоге над рабочим: Gemini ищет `.env` вверх от рабочего каталога): сеанс ядра её не
 *      читает — прогон с галочкой по-прежнему целиком в контуре, облако человека пусто.
 *
 * Gemini говорит протоколом Gemini API (`google-genai`): шлюз ядра переводит его в
 * `chat/completions` контура. Kimi — строка вернётся, когда Kimi Code будет ставиться на Windows
 * без глобальной установки (живой Kimi проверяется в контейнере, `tools/core-linux.mjs --clis`).
 *
 * Запуск: `[STEER_CLI_DIR=<каталоги с goose, opencode, gemini через ;>]
 * node tools/qa/check-run-endpoint-cli.mjs [--only=gemini]` (или `ONLY=`). Код 2 — «не проверено»:
 * какого-то CLI нет.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const IS_WIN = process.platform === 'win32';
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['contour', 'x7', 'key', '5d1a'].join('-');
const HUMAN_KEY = ['human', 'own', 'key'].join('-');
const CONTOUR = 'x7-company';
const HUMAN_REPLY = 'ОТВЕТ-ОБЛАКА-ЧЕЛОВЕКА';
// `--only=<cli,…>` сильнее окружения: кейс блока «Тесты» выбирает строку аргументом (testName).
const ONLY = (
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length) ??
  process.env.ONLY ??
  ''
)
  .split(',')
  .filter(Boolean);
/** Срок одного хода настоящего CLI через ядро. */
const TURN_MS = Number(process.env.TURN_MS ?? 170_000);

let bad = 0;
const check = (ok, text, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const CLI_NAMES = {
  goose: IS_WIN ? ['goose.exe', 'goose.cmd'] : ['goose'],
  opencode: IS_WIN ? ['opencode.cmd', 'opencode.exe'] : ['opencode'],
  gemini: IS_WIN ? ['gemini.cmd'] : ['gemini'],
};

function findCli(id) {
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  for (const dir of dirs) {
    const name = dir && CLI_NAMES[id].find((file) => existsSync(join(dir, file)));
    if (name) return join(dir, name);
  }
  return undefined;
}

/**
 * «Облако человека»: общая заглушка `packages/stub-model` (P120 — своего кода SSE у проверки
 * нет). Наблюдатель `route` пишет КАЖДЫЙ запрос, и `/models` тоже.
 */
async function startHumanCloud() {
  const calls = [];
  const model = await startStubModel({
    models: ['human-model'],
    script: () => ({ text: HUMAN_REPLY, usage: { input: 5, output: 2 } }),
    route: ({ method, path, query, body }) => {
      calls.push({ method, url: `${path}${query}`, model: body?.model });
      return undefined;
    },
  });
  return { port: model.port, calls, close: () => model.close() };
}

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** Конфиги человека: CLI, читающий их, пошёл бы в «облако человека». */
function humanConfigs(paths, humanPort) {
  const human = `http://127.0.0.1:${humanPort}`;
  const goose = [
    'GOOSE_PROVIDER: openai',
    'GOOSE_MODEL: human-model',
    `OPENAI_HOST: ${human}`,
    'GOOSE_MODE: auto',
    'extensions: {}',
    '',
  ].join('\n');
  const opencode = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      humanp: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Human',
        options: { baseURL: `${human}/v1`, apiKey: HUMAN_KEY },
        models: { 'human-model': {} },
      },
    },
    model: 'humanp/human-model',
    small_model: 'humanp/human-model',
    agent: { build: { model: 'humanp/human-model' } },
  });
  // Gemini: вход ключом в облако человека — так его настроил бы сам человек.
  const geminiEnv = [
    `GOOGLE_GEMINI_BASE_URL=${human}`,
    `GEMINI_API_KEY=${HUMAN_KEY}`,
    'GEMINI_MODEL=human-model',
    '',
  ].join('\n');
  return {
    goose,
    geminiEnv,
    write: () => {
      put(paths.goose, goose);
      put(join(paths.gooseDir, 'secrets.yaml'), `OPENAI_API_KEY: ${HUMAN_KEY}\n`);
      put(paths.opencode, opencode);
      put(
        paths.geminiSettings,
        JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
      );
      put(paths.geminiEnv, geminiEnv);
    },
  };
}

async function main() {
  const found = Object.fromEntries(
    Object.keys(CLI_NAMES)
      .filter((id) => ONLY.length === 0 || ONLY.includes(id))
      .map((id) => [id, findCli(id)]),
  );
  for (const [id, path] of Object.entries(found)) console.log(`${id}: ${path ?? 'НЕ НАЙДЕН'}`);
  const missing = Object.keys(found).filter((id) => !found[id]);
  const present = Object.keys(found).filter((id) => found[id]);
  if (present.length === 0) {
    console.log('Не проверено: ни одного CLI нет ни в STEER_CLI_DIR, ни в PATH.');
    process.exit(2);
  }

  // Дом и конфиги CLI — временные ДО импорта кода панели и ядра и до первого спавна:
  // хост сеанса ядра и процесс CLI наследуют это окружение.
  const root = mkdtempSync(join(tmpdir(), 'cc-x7-live-'));
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'home', 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    GOOSE_DISABLE_KEYRING: '1',
  });
  const cliDirs = present.map((id) => dirname(found[id]));
  process.env.PATH = [...cliDirs, process.env.PATH ?? process.env.Path ?? ''].join(delimiter);

  const { AppStore } = await import('../../apps/server/src/lib/app-store/app-store.ts');
  const { coreGateway } = await import('./core-gateway.mjs');
  const { reapCoreSessions } = await import('./throwaway-stand.mjs');
  const { writePlatform, writeToken } =
    await import('../../apps/server/src/domains/platform/store/store.ts');
  const { coreContourRoutes } =
    await import('../../apps/server/src/domains/platform/routing/core-contour.ts');
  const { startCoreForeignChat, withRoutes } =
    await import('../../apps/server/src/domains/chat/core-foreign/core-foreign-start.ts');
  const { bootCore } = await import('../../apps/core/src/bootstrap/boot.ts');
  const { createCoreCaller } = await import('../../apps/server/src/domains/core-ask/core-ask.ts');
  const { createCoreChatPort } =
    await import('../../apps/server/src/domains/chat/core-run/core-chat-port.ts');
  const { gooseConfigDir, opencodeConfigDir } =
    await import('../../apps/server/src/providers/catalog/config-dirs.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');
  const { defaultPlatformTransport } =
    await import('../../packages/contracts/src/platform-transport.ts');
  const { startStubPlatform } = await import('./stub-platform.mjs');

  const paths = {
    gooseDir: gooseConfigDir(),
    goose: join(gooseConfigDir(), 'config.yaml'),
    opencode: join(opencodeConfigDir(), 'opencode.json'),
    geminiSettings: join(homedir(), '.gemini', 'settings.json'),
    geminiEnv: join(homedir(), '.gemini', '.env'),
    // Над каталогами задач (`<дом>/work/<cli>-<метка>`): Gemini ищет `.env` вверх от рабочего.
    workEnv: join(root, 'home', 'work', '.env'),
  };
  // Страховка от записи мимо временного дома: каждый путь обязан лежать в нём.
  for (const path of [paths.goose, paths.opencode, paths.geminiSettings, paths.geminiEnv]) {
    if (!path.startsWith(root)) throw new Error(`конфиг CLI вне временного дома: ${path}`);
  }

  const stub = await startStubPlatform({ port: 0 });
  const human = await startHumanCloud();
  const configs = humanConfigs(paths, human.port);
  configs.write();
  // Шлюз держит ядро (этап 10): хост звеньев на временном доме, ядро — на том же доме.
  const gateway = coreGateway();
  let core;
  try {
    const store = new AppStore(appData);
    const platform = {
      id: CONTOUR,
      title: 'Контур X7',
      driver: 'enterprise-platform',
      baseUrl: stub.url,
      enabled: true,
      mode: 'required',
      budgetUsd: 0,
      budgetSince: '',
      capabilities: [],
      targets: [],
      consumers: [],
      projectPaths: [],
      agents: [],
      toolShim: true,
      contourPrompt: true,
      defaultModel: 'stub-chat',
      consumerModels: {},
      modelMap: {},
      rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
      caCertPath: '',
      transport: defaultPlatformTransport(),
    };
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    store.updateSettings({ activePlatformId: CONTOUR });
    await gateway.start({ appDataDir: appData });
    core = await bootCore({ home: gateway.home(), build: 'x7-live-qa', panelAppData: appData });
    const port = createCoreChatPort(createCoreCaller(() => gateway.home()));

    /** Лента сеанса задачи: текст ответов и ошибки, пока сеанс не кончился или не вышел срок. */
    const sessionText = async (taskId, deadline) => {
      let sessionId = '';
      let from = 0;
      const texts = [];
      for (;;) {
        const view = await port.view(taskId).catch(() => null);
        if (!sessionId) sessionId = view?.sessions?.[0]?.sessionId ?? '';
        if (sessionId) {
          const page = await port.page(taskId, sessionId, from).catch(() => null);
          if (page) {
            from = page.next;
            for (const event of page.events) {
              if (event.kind === 'assistant-text' || event.kind === 'error') {
                texts.push(JSON.stringify(event.data));
              }
              if (event.kind === 'turn-end') return { view, texts, ended: true };
            }
            if (page.done) return { view, texts, ended: true };
          }
        }
        const terminal = view && ['done', 'failed', 'cancelled'].includes(view.state);
        if (terminal || Date.now() > deadline) return { view, texts, ended: Boolean(terminal) };
        await wait(500);
      }
    };

    /** Последние строки журнала задачи ядра (`<дом>/tasks/<id>/*.jsonl`) — для разбора провала. */
    const journalTail = (taskId, count = 14) => {
      try {
        const dir = join(gateway.home(), 'tasks', taskId);
        const name = readdirSync(dir).find((file) => file.endsWith('.jsonl'));
        return readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .slice(-count)
          .map((line) => {
            const row = JSON.parse(line);
            return `${row.kind} ${JSON.stringify(row.data).slice(0, 220)}`;
          });
      } catch (error) {
        return [`журнал не прочитан: ${error}`];
      }
    };

    /** Один ход чата CLI задачей ядра, как его заводит сервер (`startCoreForeignChat`). */
    const turn = async (id, consumers, label, mode = 'required') => {
      writePlatform(store, { ...platform, consumers, mode });
      // Ядро пересобирает маршруты по наблюдателю за state.json; здесь — тем же путём, сразу.
      await gateway.refresh();
      const work = join(root, 'home', 'work', `${id}-${label}`);
      mkdirSync(work, { recursive: true });
      // Задача ядра работает в репозитории: оценка без git отказывает раньше маршрута.
      for (const args of [
        ['init', '-q', '-b', 'main'],
        [
          '-c',
          'user.name=x7',
          '-c',
          'user.email=x7@example.invalid',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
      ]) {
        const git = spawnSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true });
        if (git.status !== 0) throw new Error(`git ${args[0]}: ${git.stderr}`);
      }
      const before = { stub: stub.calls.length, human: human.calls.length };
      const eventsBefore = (await gateway.events()).length;
      const routes = coreContourRoutes(store, `foreign:${id}`, id);
      // Ядро не ответило — провал строки с причиной, а не обрыв проверки посреди CLI.
      const started = await startCoreForeignChat(port, {
        cli: id,
        cwd: work,
        prompt: 'скажи готов',
        title: `x7 ${id} ${label}`,
        ...withRoutes(routes),
      }).catch((error) => ({ ok: false, code: 'core-unreachable', message: String(error) }));
      const seen = started.ok
        ? await sessionText(started.taskId, Date.now() + TURN_MS)
        : { view: null, texts: [], ended: true };
      if (started.ok) {
        await port
          .command(started.taskId, 'cancel', { reason: 'x7 live check done' })
          .catch(() => undefined);
      }
      if (started.ok && (!seen.ended || !seen.texts.length)) {
        // Почему нет ответа: хвост журнала задачи ядра — сеанс, маршрут, отказ.
        console.log(`  (${id}/${label}: ответа нет; хвост журнала задачи)`);
        for (const line of journalTail(started.taskId)) console.log(`    ${line}`);
      }
      return {
        routes,
        started,
        state: seen.view?.state ?? '',
        reply: seen.texts.join('\n'),
        ups: stub.calls.slice(before.stub).filter((call) => call.method === 'POST'),
        humanCalls: human.calls.slice(before.human),
        // След звена — старые сверху (не больше 50): новые — хвост списка.
        events: (await gateway.events()).slice(eventsBefore),
      };
    };

    for (const id of present) {
      console.log(`\n── ${id} ──`);
      configs.write();

      console.log('1. Галочка стоит: задача ядра через контур');
      const on = await turn(id, [`foreign:${id}`], 'on');
      check(
        on.routes?.[0]?.route.id === `gateway:${CONTOUR}`,
        `${id}: разрешённый набор задачи — маршрут контура ${on.routes?.[0]?.route.id ?? '—'}`,
      );
      check(on.started.ok, `${id}: задача ядра заведена и запущена`, JSON.stringify(on.started));
      check(
        on.reply.includes('готов'),
        `${id}: в ленте сеанса ответ контура (задача ${on.state})`,
        on.reply.slice(0, 300),
      );
      check(
        on.ups.length > 0 && on.ups.every((call) => call.path.endsWith('/chat/completions')),
        `${id}: наверх ушёл chat/completions (${on.ups.length})`,
        on.ups.map((call) => call.path).join(', '),
      );
      check(
        on.ups.length > 0 && on.ups.every((call) => String(call.authorization).includes(SECRET)),
        `${id}: наверх — ключ контура, подставленный шлюзом`,
      );
      check(
        on.humanCalls.length === 0,
        `${id}: облако человека не получило ни одного запроса`,
        JSON.stringify(on.humanCalls),
      );
      check(
        on.events.length > 0,
        `${id}: след шлюза контура о прогоне (${on.events.length})`,
        JSON.stringify(on.events.slice(-3)),
      );

      // Решение 02.11: обязательный контур ведёт через себя каждого потребителя, галочка
      // отмечена или нет, — снятая галочка не уводит прогон в облако человека и не роняет его.
      console.log('2. Галочка снята, контур обязательный: всё равно через контур');
      const forced = await turn(id, [], 'forced');
      check(
        forced.routes?.[0]?.route.id === `gateway:${CONTOUR}` &&
          forced.routes[0].modelPattern === 'stub-chat',
        `${id}: без галочки при «обязательно» набор — маршрут контура с моделью контура (${forced.routes?.[0]?.route.id ?? '—'} ${forced.routes?.[0]?.modelPattern ?? ''})`,
      );
      check(
        forced.started.ok && forced.reply.includes('готов'),
        `${id}: задача пошла и ответил контур (задача ${forced.state})`,
        `${JSON.stringify(forced.started)} ${forced.reply.slice(0, 200)}`,
      );
      check(
        forced.ups.length > 0 &&
          forced.ups.every((call) => String(call.authorization).includes(SECRET)),
        `${id}: наверх — только контур с его ключом (${forced.ups.length})`,
        forced.ups.map((call) => call.path).join(', '),
      );
      check(
        forced.humanCalls.length === 0,
        `${id}: облако человека не получило ни одного запроса`,
        JSON.stringify(forced.humanCalls),
      );

      // «По возможности»: галочка решает, снятая — маршрута нет. У Goose и OpenCode нет маршрута
      // входа CLI, так что набор ядра по умолчанию пуст и отказ один при любой политике ядра
      // (ядро читает режим контура при загрузке — здесь от этого исход не зависит).
      console.log(
        '2б. Галочка снята, контур «по возможности»: маршрута нет — отказ ядра до процесса',
      );
      const off = await turn(id, [], 'off', 'best-effort');
      check(
        off.routes === undefined,
        `${id}: без галочки при «по возможности» набор задачи не задан`,
      );
      check(
        // Отказ именно маршрутом: CLI без маршрута входа вне набора по умолчанию. Другой код
        // (нет git, ядро не ответило) значил бы, что до суда маршрута дело не дошло.
        !off.started.ok && off.started.code === 'outside-allowed-set',
        `${id}: ядро отказало задаче без маршрута по имени (${off.started.ok ? off.state : off.started.code})`,
        `${JSON.stringify(off.started)} ${off.reply.slice(0, 200)}`,
      );
      check(
        off.ups.length === 0 && off.humanCalls.length === 0,
        `${id}: ни контур, ни облако человека запроса не видели (${off.ups.length}/${off.humanCalls.length})`,
        JSON.stringify(off.humanCalls),
      );
    }

    if (present.includes('goose')) {
      console.log('\n3. Настройка конфига человека мимо контура — сеанс ядра её не читает');
      put(
        paths.goose,
        `${configs.goose}GOOSE_LEAD_PROVIDER: openai\nGOOSE_LEAD_MODEL: human-model\n`,
      );
      const bypass = await turn('goose', ['foreign:goose'], 'bypass');
      check(
        bypass.reply.includes('готов') && bypass.ups.length > 0,
        `goose: с GOOSE_LEAD_PROVIDER в конфиге человека прогон всё равно в контуре (${bypass.ups.length})`,
        bypass.reply.slice(0, 300),
      );
      check(
        bypass.humanCalls.length === 0,
        'goose: облако человека не получило ни одного запроса',
        JSON.stringify(bypass.humanCalls),
      );
    }

    if (present.includes('gemini')) {
      console.log(
        '\n3. Gemini: `.env` облака человека над рабочим каталогом — сеанс ядра его не берёт',
      );
      put(paths.workEnv, configs.geminiEnv);
      const bypass = await turn('gemini', ['foreign:gemini'], 'bypass');
      rmSync(paths.workEnv, { force: true });
      check(
        bypass.reply.includes('готов') && bypass.ups.length > 0,
        `gemini: с .env человека над рабочим каталогом прогон всё равно в контуре (${bypass.ups.length})`,
        bypass.reply.slice(0, 300),
      );
      check(
        bypass.humanCalls.length === 0,
        'gemini: облако человека не получило ни одного запроса',
        JSON.stringify(bypass.humanCalls),
      );
    }
  } finally {
    await core?.stop().catch(() => undefined);
    if (gateway.home()) reapCoreSessions(gateway.home());
    await gateway.stop();
    await stub.close();
    await human.close();
    await wait(1000);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  if (missing.length > 0) {
    console.log(`\nНе проверено: нет ${missing.join(', ')}. Провалов среди проверенных: ${bad}`);
    process.exit(bad === 0 ? 2 : 1);
  }
  console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!process.features.typescript && !process.env.CC_X7_LIVE_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_X7_LIVE_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
