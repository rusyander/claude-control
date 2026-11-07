/**
 * Контур на ЖИВОЙ платформе компании: настоящий ключ, настоящий адрес API, настоящие CLI задачей ядра.
 *
 * Чем отличается от соседей. `check-platform-wire.mjs` и `check-run-endpoint-cli.mjs` ставят над
 * шлюзом `stub-platform.mjs` — форма ответов там та, какой её записал справочник. Здесь над шлюзом
 * ядра стоит сама платформа (локальный стенд), и проверяется то, что стаб доказать не может: ключ,
 * выданный её админкой, принят её API; её каталог моделей прочитан пробой панели; её отказы
 * (чужой ключ, модель вне списка ключа, недоступный провайдер модели) доходят до ленты сеанса CLI
 * словами панели, а не сырым кодом.
 *
 * Подменено только то, что над платформой: ничего. Дом, конфиги и данные CLI — во временных
 * каталогах; ядро, хост звеньев, шлюз и сеанс CLI — код ядра; ход чата (реестр чата из сборки
 * сервера → `CoreChatRun`, `panel-chat-turn.mjs`) и маршрут контура — код панели. Ключ не печатается и в журнал не попадает.
 *
 * Для каждого CLI (`CLIS`, по умолчанию `claude,qwen`):
 *   1. разрешённая ключу модель: запрос дошёл до платформы с её ключом (ответ модели или названный
 *      отказ ПРОВАЙДЕРА — то есть ключ и модель приняты), в следе шлюза контура есть запись;
 *   2. чужой ключ: лента называет «Контур отклонил ключ», ответа модели нет;
 *   3. модель вне списка ключа: лента называет эту модель и «не разрешена»;
 * и один раз:
 *   0. проба панели с ключом читает каталог ключа (модель `PLATFORM_MODEL` в нём), с чужим ключом —
 *      исход `unauthorized`; картинки: у моделей ключа флага рисования нет — режим «Картинка» закрыт;
 *   4. обязательный контур без ключа: задача не идёт, причина названа, на платформу запроса нет.
 *
 * Запуск: `[PLATFORM_STAND_KEY_FILE=<dotenv>] [PLATFORM_STAND_KEY_VAR=<имя строки>]
 * [PLATFORM_API=http://api.localhost] [PLATFORM_MODEL=qwen2.5:7b] [PLATFORM_FORBIDDEN_MODEL=gpt-4o]
 * node tools/qa/check-contour-stand.mjs [--only=claude]`.
 * Код 2 — «не проверено»: нет ключа, стенд не отвечает или нет CLI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const IS_WIN = process.platform === 'win32';
const CONTOUR = 'stand-live';
const API = (process.env.PLATFORM_API ?? 'http://api.localhost').replace(/\/+$/, '');
const MODEL = process.env.PLATFORM_MODEL ?? 'qwen2.5:7b';
const FORBIDDEN = process.env.PLATFORM_FORBIDDEN_MODEL ?? 'gpt-4o';
// Claude Code повторяет ответ 5xx до десяти раз с нарастающей паузой (502 стенда — ~6 мин) и только
// потом кончает ход словами ошибки: срок хода у него длиннее, иначе лента пуста по сроку проверки.
const turnMs = (id) => Number(process.env.TURN_MS ?? (id === 'claude' ? 480_000 : 170_000));
const ONLY = (
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length) ??
  process.env.CLIS ??
  'claude,qwen'
)
  .split(',')
  .filter(Boolean);

/** Тексты шлюза ядра (`hop-host/gateway/texts.data.ts`) на обоих языках — язык ядра здесь не важен. */
const SAID = {
  keyRejected: /Контур отклонил ключ|contour rejected the key/i,
  // Шлюз называет запрет словами контура; ядро, знающее список моделей ключа, отказывает раньше
  // запроса и называет модель в причине шага (`compatRefusalReason`) — чат показывает этот отказ
  // текстом панели по коду `core-chat-contour-model` («модель X недоступна в контуре…»).
  modelForbidden: (model) => {
    const name = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(Ключу не разрешена модель «?|Model “|model_absent: model )${name}|(модель|model) ${name} (недоступна в контуре|is not available in contour) \\S+ — (ключ контура её не разрешает|the contour key does not allow it)`,
    );
  },
  // Без потока платформа отвечает 502 (текст статуса шлюза), в потоке — 200 и кадром
  // `{"error":{"code":"upstream_error"}}` (текст `gateway-upstream-aborted` со словами платформы).
  providerDown:
    /Контур не смог дозваться до модели|contour could not reach the model|Контур прервал ответ|contour aborted the answer/i,
};

let bad = 0;
const check = (ok, text, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) bad += 1;
};
const notChecked = (why) => {
  console.log(`Не проверено: ${why}`);
  process.exit(2);
};

const CLI_NAMES = {
  claude: IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'],
  qwen: IS_WIN ? ['qwen.cmd', 'qwen.exe'] : ['qwen'],
};

function findCli(id) {
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    const name = dir && CLI_NAMES[id]?.find((file) => existsSync(join(dir, file)));
    if (name) return join(dir, name);
  }
  return undefined;
}

/**
 * Ключ стенда из файла dotenv — тот же уговор, что у съёмки (`platform-shots-lib.mjs standKey`).
 * Без переменных — файл `.agent/private/stand-key.env` (вне git) и строка `AGENTDECK_CONTOUR_CHECK_KEY`:
 * так кейс блока «Тесты» гоняет проверку без ручного окружения; файла нет — «не проверено».
 */
function standKey() {
  const file =
    process.env.PLATFORM_STAND_KEY_FILE ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.agent', 'private', 'stand-key.env');
  const name = (process.env.PLATFORM_STAND_KEY_VAR ?? 'AGENTDECK_CONTOUR_CHECK_KEY').replace(
    /[^A-Za-z0-9_]/g,
    '',
  );
  if (!file || !name || !existsSync(file)) return '';
  return (
    readFileSync(file, 'utf8')
      .match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
      ?.trim() ?? ''
  );
}

async function main() {
  const key = standKey();
  if (!key) notChecked('нет ключа стенда (PLATFORM_STAND_KEY_FILE / PLATFORM_STAND_KEY_VAR)');
  // Транспорт ядра, а не встроенный fetch: `api.localhost` резолвер Windows не знает, ядро — знает.
  const { createCaFetch } = await import('../../apps/core/src/platform/net/ca-fetch.ts');
  const alive = await createCaFetch('', process.env)(`${API}/v1/models`, {
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!alive) notChecked(`стенд ${API} не отвечает`);

  const found = Object.fromEntries(ONLY.map((id) => [id, findCli(id)]));
  for (const [id, path] of Object.entries(found)) console.log(`${id}: ${path ?? 'НЕ НАЙДЕН'}`);
  const present = Object.keys(found).filter((id) => found[id]);
  const missing = Object.keys(found).filter((id) => !found[id]);

  // Дом и конфиги CLI — временные ДО импорта кода панели и ядра: хост сеанса и CLI наследуют их.
  const root = mkdtempSync(join(tmpdir(), 'cc-stand-live-'));
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'home', 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
  });
  process.env.PATH = [
    ...present.map((id) => dirname(found[id])),
    process.env.PATH ?? process.env.Path ?? '',
  ].join(delimiter);

  const { AppStore } = await import('../../apps/server/src/lib/app-store/app-store.ts');
  const { coreGateway } = await import('./core-gateway.mjs');
  const { reapCoreSessions } = await import('./throwaway-stand.mjs');
  const { writePlatform, writeToken, forgetToken } =
    await import('../../apps/server/src/domains/platform/store/store.ts');
  const { probePlatform } = await import('../../apps/server/src/domains/platform/probe/probe.ts');
  const { chatContourRoutes } =
    await import('../../apps/server/src/domains/platform/routing/core-contour.ts');
  const { panelChatRuns, startPanelChat } = await import('./panel-chat-turn.mjs');
  const { bootCore } = await import('../../apps/core/src/bootstrap/boot.ts');
  const { createCoreCaller } = await import('../../apps/server/src/domains/core-ask/core-ask.ts');
  const { createCoreChatPort } =
    await import('../../apps/server/src/domains/chat/core-run/core-chat-port.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');
  const { defaultPlatformTransport } =
    await import('../../packages/contracts/src/platform-transport.ts');

  const platform = {
    id: CONTOUR,
    title: 'Стенд платформы',
    driver: 'enterprise-platform',
    baseUrl: API,
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
    defaultModel: MODEL,
    consumerModels: {},
    modelMap: {},
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    caCertPath: '',
    transport: defaultPlatformTransport(),
  };

  // ── 0. Проба панели: каталог ключа и картинки ────────────────────────────────────────────────
  console.log('\n0. Проба панели против платформы');
  const probe = await probePlatform({ platform, token: key });
  const ids = probe.models.map((model) => model.id);
  check(probe.outcome === 'ok', `проба с ключом: исход ${probe.outcome}`, probe.detail);
  check(ids.includes(MODEL), `каталог ключа читается, ${MODEL} в нём (${ids.join(', ')})`);
  const draw = probe.capabilities.find((item) => item.id === 'image-generation');
  console.log(`  картинки по пробе: ${JSON.stringify(draw ?? null)}`);
  check(
    draw?.state === 'no',
    'рисующей модели у ключа нет — режим «Картинка» закрыт пробой, а не обещан',
    JSON.stringify(draw),
  );
  const wrongProbe = await probePlatform({ platform, token: `${key}x` });
  check(
    wrongProbe.outcome === 'unauthorized',
    `проба с чужим ключом: исход ${wrongProbe.outcome}`,
    wrongProbe.detail,
  );

  if (present.length === 0) {
    rmSync(root, { recursive: true, force: true });
    notChecked(`нет ни одного CLI из ${ONLY.join(', ')}; провалов пробы: ${bad}`);
  }

  const gateway = coreGateway();
  let core;
  try {
    const store = new AppStore(appData);
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, key);
    store.updateSettings({ activePlatformId: CONTOUR });
    await gateway.start({ appDataDir: appData });
    core = await bootCore({ home: gateway.home(), build: 'stand-live-qa', panelAppData: appData });
    const port = createCoreChatPort(createCoreCaller(() => gateway.home()));
    const chatRuns = await panelChatRuns({ appData, store, coreHome: gateway.home() });

    const sessionText = async (taskId, deadline) => {
      let sessionId = '';
      let from = 0;
      const texts = [];
      const kinds = [];
      for (;;) {
        const view = await port.view(taskId).catch(() => null);
        if (!sessionId) sessionId = view?.sessions?.[0]?.sessionId ?? '';
        if (sessionId) {
          const page = await port.page(taskId, sessionId, from).catch(() => null);
          if (page) {
            from = page.next;
            for (const event of page.events) {
              kinds.push(event.kind);
              if (event.kind === 'assistant-text' || event.kind === 'error') {
                texts.push(JSON.stringify(event.data));
              }
              if (event.kind === 'turn-end') {
                // Ход с ошибкой несёт слова CLI о ней в самом конце хода (`stream-view.ts`):
                // у Claude Code отказ шлюза после повторов приходит только так.
                if (event.data?.isError && event.data.text) texts.push(String(event.data.text));
                return { view, texts, kinds };
              }
            }
            if (page.done) return { view, texts, kinds };
          }
        }
        const terminal = view && ['done', 'failed', 'cancelled'].includes(view.state);
        // Задача ждёт человека (вопрос ядра открыт), а сеанса так и не было: ход отказан до
        // первого запроса — причина в шагах, ждать срока незачем.
        const parked = view && !sessionId && (view.asks ?? []).some((ask) => ask.state === 'open');
        if (terminal || parked || Date.now() > deadline) {
          for (const step of view?.steps ?? []) {
            if (step.state === 'failed' && step.reason) texts.push(`step: ${step.reason}`);
          }
          return { view, texts, kinds };
        }
        await wait(500);
      }
    };

    /**
     * Один ход чата CLI так, как его заводит панель (реестр чата → задача ядра, маршрут — галочка
     * «Чат» или обязательный контур); `edit` правит контур и ключ до хода.
     */
    const turn = async (id, label, edit = {}) => {
      writePlatform(store, { ...platform, ...edit.platform });
      if (edit.token === null) forgetToken(appData, CONTOUR);
      else writeToken(appData, CONTOUR, edit.token ?? key);
      await gateway.refresh();
      const work = join(root, 'home', 'work', `${id}-${label}`);
      mkdirSync(work, { recursive: true });
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['-c', 'user.name=qa', '-c', 'user.email=qa@example.invalid', 'commit', '-q'],
      ]) {
        const full = args[0] === 'init' ? args : [...args, '--allow-empty', '-m', 'init'];
        const git = spawnSync('git', full, { cwd: work, encoding: 'utf8', windowsHide: true });
        if (git.status !== 0) throw new Error(`git ${full[0]}: ${git.stderr}`);
      }
      const eventsBefore = (await gateway.events()).length;
      // Набор, который сборка чата спросит для этого CLI (`chat-wiring.ts` `routes`).
      const routes = chatContourRoutes(store, id);
      const started = await startPanelChat(chatRuns, {
        appData,
        store,
        cli: id,
        cwd: work,
        prompt: 'Ответь одним словом: готов',
      }).catch((error) => ({ ok: false, code: 'core-unreachable', message: String(error) }));
      const seen = started.ok
        ? await sessionText(started.taskId, Date.now() + turnMs(id))
        : { view: null, texts: [], kinds: [] };
      // «Остановить» человека: прогон снимает задачу ядра (`CoreChatRun.stop` → `cancel`).
      if (started.ok) chatRuns.stop(started.key);
      // Отказ до сеанса (ядро знает список моделей ключа и не пускает шаг) человек видит ошибкой
      // хода, а не лентой сеанса: её текст и есть то, что проверяется.
      const reply = started.ok ? seen.texts.join('\n') : started.message;
      if (reply.includes(key)) throw new Error('ключ стенда попал в ленту сеанса');
      return {
        routes,
        started,
        state: seen.view?.state ?? '',
        view: seen.view,
        reply,
        kinds: seen.kinds,
        events: (await gateway.events()).slice(eventsBefore),
      };
    };

    for (const id of present) {
      console.log(`\n── ${id} ──`);
      console.log(`1. Модель ключа ${MODEL}: запрос дошёл до платформы с её ключом`);
      const on = await turn(id, 'allowed');
      check(
        on.routes?.[0]?.route.id === `gateway:${CONTOUR}` && on.routes[0].modelPattern === MODEL,
        `${id}: маршрут контура с моделью ключа (${on.routes?.[0]?.route.id ?? '—'} ${on.routes?.[0]?.modelPattern ?? ''})`,
      );
      check(on.started.ok, `${id}: задача ядра заведена и запущена`, JSON.stringify(on.started));
      check(
        on.events.length > 0,
        `${id}: след шлюза контура о прогоне (${on.events.length})`,
        JSON.stringify(on.events.slice(-2)),
      );
      const answered = /готов/i.test(on.reply);
      const providerDown = SAID.providerDown.test(on.reply);
      check(
        (answered || providerDown) && !SAID.keyRejected.test(on.reply),
        `${id}: платформа приняла ключ и модель — ${answered ? 'ответ модели' : providerDown ? 'названный отказ провайдера модели (502)' : 'нет ни ответа, ни названного отказа'}`,
        on.reply.slice(0, 400),
      );
      console.log(`  лента: ${on.reply.slice(0, 300)}`);
      if (process.env.QA_DEBUG) {
        const dump = JSON.stringify({
          state: on.state,
          kinds: on.kinds,
          events: on.events.slice(-4),
          view: on.view,
        });
        console.log(`  debug: ${dump.replaceAll(key, '***').slice(0, 3000)}`);
      }

      console.log('2. Чужой ключ: отказ назван');
      const wrong = await turn(id, 'wrong-key', { token: `${key}x` });
      check(
        SAID.keyRejected.test(wrong.reply) && !/готов/i.test(wrong.reply),
        `${id}: лента называет отклонённый ключ`,
        wrong.reply.slice(0, 400),
      );

      console.log(`3. Модель вне списка ключа (${FORBIDDEN}): отказ назван`);
      const forbidden = await turn(id, 'forbidden', { platform: { defaultModel: FORBIDDEN } });
      check(
        forbidden.routes?.[0]?.modelPattern === FORBIDDEN,
        `${id}: задача просит ${FORBIDDEN} (${forbidden.routes?.[0]?.modelPattern ?? '—'})`,
      );
      check(
        SAID.modelForbidden(FORBIDDEN).test(forbidden.reply),
        `${id}: лента называет модель и что ключу она не разрешена`,
        forbidden.reply.slice(0, 400),
      );
    }

    console.log('\n4. Обязательный контур без ключа: задача не идёт, причина названа');
    const id = present[0];
    const keyless = await turn(id, 'keyless', { token: null });
    const refused = !keyless.started.ok || !/готов/i.test(keyless.reply);
    const why = keyless.started.ok
      ? keyless.reply
      : `${keyless.started.code}: ${keyless.started.message}`;
    check(refused && why.trim().length > 0, `${id}: отказ назван — ${why.slice(0, 200)}`, why);
    check(
      keyless.events.every((event) => !/^2\d\d$/.test(String(event.status ?? ''))),
      `${id}: удачного ответа платформы без ключа нет (${keyless.events.length} записей следа)`,
      JSON.stringify(keyless.events.slice(-2)),
    );
  } finally {
    await core?.stop().catch(() => undefined);
    if (gateway.home()) reapCoreSessions(gateway.home());
    await gateway.stop();
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

if (!process.features.typescript && !process.env.CC_STAND_LIVE_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_STAND_LIVE_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
