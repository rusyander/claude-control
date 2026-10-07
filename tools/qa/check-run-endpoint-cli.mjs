/**
 * Контур окружением прогона (X7): НАСТОЯЩИЕ Kimi Code, Goose, OpenCode и Gemini CLI
 * из чата панели → шлюз панели → стаб-контур.
 *
 * У этих трёх CLI нет переменных адреса в реестре и нет файловой цели: адрес
 * контура едет только окружением ОДНОГО прогона (`runEndpoint` в каталоге), в
 * переменных, которые задокументированы у каждого как перебивающие конфиг.
 * Обещание человеку — «с галочкой ни один запрос не уходит провайдером из
 * твоего конфига», и проверить его можно только настоящим CLI: таблица
 * `routing.run-endpoint.test.ts` доказывает решение, `check-platform-run-env.mjs`
 * — что окружение дошло до процесса, и ни та ни другая не знает, послушается ли
 * его сам CLI.
 *
 * Подменено только то, что над панелью и вне её: контур (`stub-platform.mjs`) и
 * «облако человека» — вторая заглушка, на которую смотрит конфиг каждого CLI.
 * Конфиги — во временных каталогах (`KIMI_CODE_HOME`, `APPDATA`/`HOME`,
 * `XDG_*`); настоящие `~/.kimi-code`, `%APPDATA%\Block\goose`, `~/.config/opencode`
 * не читаются и не пишутся. Чат, маршрут, спавн и шлюз — код панели, в этом
 * процессе. `GOOSE_DISABLE_KEYRING` — чтобы Goose не трогал связку ключей ОС.
 *
 * Gemini — другой путь к тому же обещанию: у него переменные адреса есть
 * (`GOOGLE_GEMINI_BASE_URL`), но говорит он диалектом Gemini API, и шлюз
 * переводит его на краю (`google-bridge.ts`). Заглушка человека отвечает ему
 * в форме Gemini; `~/.gemini` — во временном доме, системные настройки — тоже
 * (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`). Настройка мимо контура у него — способ
 * входа не ключом API.
 *
 * Для каждого CLI:
 *   1. галочка стоит — ответ контура в переписке; наверх ушёл только
 *      `chat/completions` с ключом контура; след шлюза — раздел этого CLI;
 *      заглушка человека не получила НИ ОДНОГО запроса;
 *   2. контроль: галочка снята — тот же CLI идёт в заглушку человека. Без
 *      контроля «ни одного запроса человеку» было бы обещанием проверки, которая
 *      не умеет краснеть: конфиг мог просто не читаться;
 *   3. настройка, уводящая часть прогона мимо контура (Kimi `[secondary_model]`,
 *      Goose `GOOSE_LEAD_PROVIDER`, Gemini `security.auth.selectedType`):
 *      обязательный контур отказывает с её именем, и ни одна заглушка запроса
 *      не видит.
 *
 * Запуск: `STEER_CLI_DIR=<каталоги с kimi, goose, opencode, gemini через ;> node tools/qa/check-run-endpoint-cli.mjs`
 * Код 2 — «не проверено»: какого-то CLI нет.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

const IS_WIN = process.platform === 'win32';
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['contour', 'x7', 'key', '5d1a'].join('-');
const HUMAN_KEY = ['human', 'own', 'key'].join('-');
const CONTOUR = 'x7-company';
const HUMAN_REPLY = 'ОТВЕТ-ОБЛАКА-ЧЕЛОВЕКА';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);

let bad = 0;
const check = (ok, text, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};

const CLI_NAMES = {
  kimi: IS_WIN ? ['kimi.exe', 'kimi.cmd'] : ['kimi'],
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

/** «Облако человека»: OpenAI-совместимая заглушка, которая пишет каждый запрос. */
function startHumanCloud() {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Не JSON — модели в запросе нет, пишем без неё.
      }
      calls.push({ method: req.method, url: req.url, model: body.model });
      // Gemini API: ответ в его форме, иначе контроль «без галочки» упал бы на
      // разборе, а не показал, что конфиг человека действует.
      if (/:(stream)?generateContent/i.test(req.url)) {
        const candidate = {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: HUMAN_REPLY }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        };
        if (req.url.includes('streamGenerateContent')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify(candidate)}\r\n\r\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(candidate));
        }
        return;
      }
      if (req.url.includes(':countTokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ totalTokens: 5 }));
        return;
      }
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'human-model', object: 'model' }] }));
        return;
      }
      const base = { id: 'h1', created: 1, model: body.model };
      const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        frame({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: HUMAN_REPLY } }],
        });
        frame({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage,
        });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: HUMAN_REPLY },
              finish_reason: 'stop',
            },
          ],
          usage,
        }),
      );
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        calls,
        close: () => new Promise((closed) => server.close(closed)),
      }),
    ),
  );
}

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** Конфиги человека: каждый CLI без галочки пошёл бы в «облако человека». */
function humanConfigs(paths, humanPort) {
  const human = `http://127.0.0.1:${humanPort}`;
  const kimi = [
    'default_model = "human-model"',
    '',
    '[providers.humanp]',
    'type = "openai"',
    `base_url = "${human}/v1"`,
    `api_key = "${HUMAN_KEY}"`,
    '',
    '[models.human-model]',
    'provider = "humanp"',
    'model = "human-upstream"',
    'max_context_size = 100000',
    '',
  ].join('\n');
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
  // Gemini: вход ключом API и адрес своего облака в `.env` — так человек и
  // ходит в свой прокси Gemini.
  const geminiSettings = JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } });
  const geminiEnv = [
    `GOOGLE_GEMINI_BASE_URL=${human}`,
    `GEMINI_API_KEY=${HUMAN_KEY}`,
    'GEMINI_MODEL=human-model',
    '',
  ].join('\n');
  return {
    kimi,
    goose,
    opencode,
    write: () => {
      put(paths.kimi, kimi);
      put(paths.goose, goose);
      put(join(paths.gooseDir, 'secrets.yaml'), `OPENAI_API_KEY: ${HUMAN_KEY}\n`);
      put(paths.opencode, opencode);
      put(paths.geminiSettings, geminiSettings);
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

  // Дом и конфиги CLI — временные ДО импорта кода панели и до первого спавна:
  // процесс CLI наследует это окружение.
  const root = mkdtempSync(join(tmpdir(), 'cc-x7-live-'));
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'home', 'AppData', 'Local'),
    KIMI_CODE_HOME: join(root, 'kimi-home'),
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    GOOSE_DISABLE_KEYRING: '1',
    // Системные настройки Gemini читаются и из каталога ОС — уводим во временный.
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(root, 'gemini-system', 'settings.json'),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(root, 'gemini-system', 'system-defaults.json'),
    // Без доверия к папке Gemini в безголовом режиме отказывает до запроса.
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
  });
  const cliDirs = present.map((id) => dirname(found[id]));
  process.env.PATH = [...cliDirs, process.env.PATH ?? process.env.Path ?? ''].join(delimiter);

  const { AppStore } = await import('../../apps/server/src/lib/app-store.ts');
  const { PlatformGateway } =
    await import('../../apps/server/src/domains/platform/gateway/listener.ts');
  const { writePlatform, writeToken } =
    await import('../../apps/server/src/domains/platform/store.ts');
  const { resolveRunRoute, runRouteOf } =
    await import('../../apps/server/src/domains/platform/routing.ts');
  const { ProviderChatService } =
    await import('../../apps/server/src/domains/provider-chat/ProviderChatService.ts');
  const { createChat, readChat } =
    await import('../../apps/server/src/domains/provider-chat/store.ts');
  const { opencodeServe } = await import('../../apps/server/src/domains/opencode-serve.ts');
  const { getProvider } = await import('../../apps/server/src/providers/registry.ts');
  const { gooseConfigDir, kimiCodeHome, opencodeConfigDir } =
    await import('../../apps/server/src/providers/catalog/config-dirs.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');
  const { defaultPlatformTransport } =
    await import('../../packages/contracts/src/platform-transport.ts');
  const { startStubPlatform } = await import('./stub-platform.mjs');

  const paths = {
    kimi: join(kimiCodeHome(), 'config.toml'),
    gooseDir: gooseConfigDir(),
    goose: join(gooseConfigDir(), 'config.yaml'),
    opencode: join(opencodeConfigDir(), 'opencode.json'),
    geminiSettings: join(homedir(), '.gemini', 'settings.json'),
    geminiEnv: join(homedir(), '.gemini', '.env'),
  };
  // Страховка от записи мимо временного дома: каждый путь обязан лежать в нём.
  for (const path of [
    paths.kimi,
    paths.goose,
    paths.opencode,
    paths.geminiSettings,
    paths.geminiEnv,
  ]) {
    if (!path.startsWith(root)) throw new Error(`конфиг CLI вне временного дома: ${path}`);
  }

  const stub = await startStubPlatform({ port: 0 });
  const human = await startHumanCloud();
  const configs = humanConfigs(paths, human.port);
  configs.write();
  const gateway = new PlatformGateway();
  const chats = new ProviderChatService();
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
    await gateway.start({ store, appDataDir: appData, port: 0, spendFlushMs: 0 });
    const deps = {
      store,
      appDataDir: appData,
      gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
    };
    // Проекция — та же, что у сборки сервера (`bootstrap/runtime.ts`).
    chats.setPlatformRouting((origin, asked = '', runTag = '') =>
      runRouteOf(resolveRunRoute(deps, origin, asked, runTag)),
    );

    /** Одно сообщение чату CLI; ответ — последнее сообщение переписки целиком. */
    const turn = async (id, consumers, label) => {
      writePlatform(store, { ...platform, consumers });
      // Папка работы — внутри временного дома: Gemini ищет `.gemini/.env`, поднимаясь
      // от неё, и из `<tmp>/work` дошёл бы до настоящего дома раньше временного.
      const work = join(root, 'home', 'work', `${id}-${label}`);
      mkdirSync(work, { recursive: true });
      const chat = createChat(appData, id, { title: label, workdir: work });
      const before = { stub: stub.calls.length, human: human.calls.length };
      const eventsBefore = gateway.status().events.length;
      const sent = chats.send(
        appData,
        id,
        chat.id,
        { text: 'скажи готов' },
        { provider: getProvider(id), detect: () => true, timeoutMs: 150_000 },
      );
      if (!sent.ok) return { sent, reply: '', ups: [], humanCalls: [], events: [] };
      const deadline = Date.now() + 170_000;
      await wait(300);
      while (chats.status(chat.id).isRunning && Date.now() < deadline) await wait(500);
      if (chats.status(chat.id).isRunning)
        console.log(`  (${id}/${label}: ответа нет за 170 с — прогон ещё идёт)`);
      const messages = readChat(appData, id, chat.id)?.messages ?? [];
      const last = messages.at(-1);
      return {
        sent,
        reply: last?.role === 'assistant' ? String(last.content) : '',
        all: JSON.stringify(messages),
        ups: stub.calls.slice(before.stub).filter((call) => call.method === 'POST'),
        humanCalls: human.calls.slice(before.human),
        // Шлюз держит события новыми вперёд и не больше 50: новые — голова списка.
        events: gateway
          .status()
          .events.slice(0, Math.max(0, gateway.status().events.length - eventsBefore)),
      };
    };

    for (const id of present) {
      console.log(`\n── ${id} ──`);
      configs.write();

      console.log('1. Галочка стоит: прогон через контур');
      const on = await turn(id, [`foreign:${id}`], 'on');
      check(on.sent.ok, `${id}: сообщение принято`, JSON.stringify(on.sent));
      check(on.reply.includes('готов'), `${id}: в переписке ответ контура`, on.reply.slice(0, 300));
      check(
        on.ups.length > 0 && on.ups.every((call) => call.path.endsWith('/chat/completions')),
        `${id}: наверх ушёл chat/completions (${on.ups.length})`,
        on.ups.map((call) => call.path).join(', '),
      );
      check(
        on.ups.every((call) => String(call.authorization).includes(SECRET)),
        `${id}: наверх — ключ контура, подставленный шлюзом`,
      );
      check(
        on.humanCalls.length === 0,
        `${id}: облако человека не получило ни одного запроса`,
        JSON.stringify(on.humanCalls),
      );
      check(
        on.events.length > 0 &&
          on.events.every((event) => event.section === `foreign:${id}` && Boolean(event.runTag)),
        `${id}: след шлюза — раздел чата ${id} с меткой прогона`,
        JSON.stringify(on.events.map((event) => [event.path, event.section, event.runTag])),
      );

      console.log('2. Контроль: галочка снята — тот же CLI идёт в облако человека');
      const off = await turn(id, [], 'off');
      check(
        off.humanCalls.length > 0,
        `${id}: без галочки запрос пришёл в облако человека — конфиг человека действует`,
        `${off.reply.slice(0, 200)} ${off.all?.slice(-300) ?? ''}`,
      );
      check(off.ups.length === 0, `${id}: без галочки контур запроса не видел`);
    }

    console.log('\n3. Настройка конфига мимо контура — отказ обязательного контура');
    const bypassCases = [
      {
        id: 'kimi',
        setting: '[secondary_model] model',
        write: () => put(paths.kimi, `${configs.kimi}\n[secondary_model]\nmodel = "human-model"\n`),
      },
      {
        id: 'goose',
        setting: 'GOOSE_LEAD_PROVIDER',
        write: () =>
          put(paths.goose, `${configs.goose}GOOSE_LEAD_PROVIDER: anthropic\nGOOSE_LEAD_MODEL: x\n`),
      },
      {
        id: 'gemini',
        setting: 'security.auth.selectedType',
        write: () =>
          put(
            paths.geminiSettings,
            JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
          ),
      },
    ].filter((item) => present.includes(item.id));
    for (const item of bypassCases) {
      item.write();
      const refused = await turn(item.id, [`foreign:${item.id}`], 'bypass');
      check(
        (refused.all ?? '').includes(item.setting),
        `${item.id}: отказ называет ${item.setting}`,
        refused.all?.slice(-300),
      );
      check(
        refused.ups.length === 0 && refused.humanCalls.length === 0,
        `${item.id}: ни контур, ни облако человека запроса не видели`,
        `${refused.ups.length}/${refused.humanCalls.length}`,
      );
    }
  } finally {
    chats.stopAll();
    opencodeServe.dispose();
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
    ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, CC_X7_LIVE_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
