/**
 * Живое доказательство Т3: доходит ли адрес контура ДО ПРОЦЕССА прогона — и
 * только до него.
 *
 * Почему таблица `routing.test.ts` без этого прогона ничего не значит. Она
 * проверяет РЕШЕНИЕ (`resolveRunRoute` вернул такой-то объект) и зеленеет даже
 * тогда, когда между решением и `spawn` порвано всё: поле `platformEnv` не
 * дошло до `ChatRunner`, `spawnCliProcess` выкинул опцию `env` (так и было —
 * блокер ревью Т3), оболочка Windows съела переменную, реестр прогонов
 * подставил старое значение. Здесь не подменяется ничего, кроме самого CLI: на
 * PATH кладётся фальшивый, который печатает СВОЁ окружение в файл и выходит.
 * Ни одного токена не тратится, сеть не трогается, стенд не нужен.
 *
 * Что доказывается (каждая строка — обещание панели человеку):
 *   1. прогон чата с отмеченной галочкой «Чат» получает ANTHROPIC_BASE_URL
 *      живого шлюза, заглушку ключа и модель управляемого профиля;
 *   2. настоящий ключ контура в окружении процесса НЕ появляется;
 *   3. файл настроек CLI не меняется ни на байт — маршрут живёт в процессе;
 *   4. прогон группы разделения, чья галочка снята, идёт БЕЗ адреса шлюза,
 *      даже если адрес лежал в параметрах прошлой жизни разговора
 *      (продолжение остановленного прогона — ровно этот случай);
 *   5. агент тестов — отдельное место запуска, и его галочка работает там же;
 *   6. чат чужого CLI с отмеченной галочкой `foreign:<cli>` тоже получает
 *      адрес — в переменных, которые задокументированы у ЭТОГО CLI, — а со
 *      снятой идёт своим провайдером;
 *   7. снятые нами слои (Т8) доезжают до argv процесса флагами, дописка панели
 *      к системному промпту не уезжает вовсе, а брокер прав встаёт ПОСЛЕ
 *      `--strict-mcp-config` и потому переживает его. Что каждый флаг делает с
 *      настоящим CLI — отдельная проверка, `check-run-layers.mjs`.
 *
 * Запуск: node tools/qa/check-platform-run-env.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['contour', 'live', 'key', '9f3c'].join('-');
const CONTOUR = 'live-company';
const MODEL = 'qwen2.5:7b';
const DUMP = 'cc-env-dump.txt';
/** Ключ строки с argv в том же файле: разбор у него общий с переменными. */
const ARGV_KEY = 'CC_ARGV';
/** Копия системного промпта, снятая фальшивым CLI, пока файл панели ещё жив. */
const SYSTEM_PROMPT_COPY = 'cc-system-prompt.txt';
/** Чужой CLI для проверки: у него задокументирован и неинтерактивный флаг, и раздел переменных. */
const FOREIGN = 'qwen';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

/** Окружение, которое напечатал фальшивый CLI, разобранное в карту. */
function dumpOf(dir) {
  const path = join(dir, DUMP);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'latin1');
  const env = new Map();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
  }
  return { raw: text, env };
}

async function waitForDump(dir, seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    if (existsSync(join(dir, DUMP))) return dumpOf(dir);
    await wait(250);
  }
  return undefined;
}

/**
 * Фальшивый CLI под этим именем: печатает окружение и СВОЙ argv в рабочую папку
 * прогона.
 *
 * Argv здесь не для полноты: модель прогона уезжает флагом `--model`, и этот
 * флаг сильнее адресной переменной (Т6). Проверять модель по окружению значило
 * бы проверять то, что CLI перебьёт на следующей строке.
 *
 * Файл `--system-prompt-file` копируется ДО выгрузки: панель стирает свою
 * временную папку, как только процесс вышел, а проверка ждёт именно выгрузку.
 */
function fakeCli(bin, name) {
  if (isWindows) {
    const scan =
      `:scan\r\nif "%~1"=="" goto dump\r\n` +
      `if "%~1"=="--system-prompt-file" copy /y "%~2" "%CD%\\${SYSTEM_PROMPT_COPY}" >nul\r\n` +
      `shift\r\ngoto scan\r\n:dump\r\n`;
    writeFileSync(
      join(bin, `${name}.cmd`),
      `@echo off\r\n${scan}set > "%CD%\\${DUMP}"\r\necho ${ARGV_KEY}=%* >> "%CD%\\${DUMP}"\r\nexit /b 0\r\n`,
    );
    return;
  }
  const scan =
    `prev=""\nfor a in "$@"; do\n` +
    `  [ "$prev" = "--system-prompt-file" ] && cp "$a" "$PWD/${SYSTEM_PROMPT_COPY}"\n` +
    `  prev="$a"\ndone\n`;
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\n${scan}env > "$PWD/${DUMP}"\necho "${ARGV_KEY}=$@" >> "$PWD/${DUMP}"\nexit 0\n`,
    { mode: 0o755 },
  );
}

const platform = {
  id: CONTOUR,
  title: 'Живая проверка маршрута',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  budgetSince: '',
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  // Как у сохранённого панелью контура: схема настроек ставит оба по умолчанию,
  // а запись в обход неё без поля выключила бы промпт контура молча.
  toolShim: true,
  contourPrompt: true,
  caCertPath: '',
};

async function main() {
  // Импорт ВНУТРИ функции: наверху он случился бы до перезапуска с флагом
  // снятия типов, и на Node 22.6 сорвался бы на первом же `.ts`.
  const { AppStore } = await import('../../apps/server/src/lib/app-store.ts');
  const { PlatformGateway } =
    await import('../../apps/server/src/domains/platform/gateway/listener.ts');
  const { writePlatform, writeToken } =
    await import('../../apps/server/src/domains/platform/store.ts');
  const { buildManagedProfile, PLACEHOLDER_KEY } =
    await import('../../apps/server/src/domains/platform/apply/profile.ts');
  const { resolveRunRoute } = await import('../../apps/server/src/domains/platform/routing.ts');
  const { promptText } = await import('../../apps/server/src/domains/prompts.ts');
  const { ChatRunRegistry } = await import('../../apps/server/src/domains/chat/ChatRunRegistry.ts');
  const { ProjectTestRunRegistry } =
    await import('../../apps/server/src/domains/project-tests/runs.ts');
  const { createGroup, upsertCase } =
    await import('../../apps/server/src/domains/project-tests/store.ts');
  const { ProviderChatService } =
    await import('../../apps/server/src/domains/provider-chat/ProviderChatService.ts');
  const { createChat } = await import('../../apps/server/src/domains/provider-chat/store.ts');
  const { getProvider } = await import('../../apps/server/src/providers/registry.ts');
  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');

  const appData = mkdtempSync(join(tmpdir(), 'cc-t3-appdata-'));
  const configDir = mkdtempSync(join(tmpdir(), 'cc-t3-config-'));
  const bin = mkdtempSync(join(tmpdir(), 'cc-t3-bin-'));
  const chatDir = mkdtempSync(join(tmpdir(), 'cc-t3-chat-'));
  const groupDir = mkdtempSync(join(tmpdir(), 'cc-t3-group-'));
  const project = mkdtempSync(join(tmpdir(), 'cc-t3-project-'));
  const foreignDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-'));
  const foreignOffDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-off-'));
  const gateway = new PlatformGateway();

  try {
    fakeCli(bin, 'claude');
    fakeCli(bin, FOREIGN);
    process.env.PATH = `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`;

    // ── Состояние панели: контур сохранён, активен, ключ на месте ────────────
    const store = new AppStore(appData);
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    store.updateSettings({ activePlatformId: CONTOUR });

    // Шлюз поднимается НАСТОЯЩИЙ: порт маршруту отдаёт живой слушатель, а не
    // запись в настройках — именно это отличие и стоило Т1 одного отказа.
    await gateway.start({ store, appDataDir: appData, port: 0 });
    const port = gateway.status().port;
    check(gateway.status().running && port > 0, `шлюз поднят на порту ${port}`);

    // Модель управляемого профиля — то, что человек выбрал в панели. Профиль
    // заводится тем же построителем, что и при применении контура.
    store.updateSettings({
      endpointProfiles: [
        buildManagedProfile(platform, { enabled: true, port, forceStream: true }, MODEL),
      ],
    });

    // Файл настроек CLI до прогонов — и его отпечаток.
    const settingsPath = join(configDir, 'settings.json');
    writeFileSync(settingsPath, '{\n  "model": "opus"\n}\n', 'utf8');
    const settingsBefore = readFileSync(settingsPath, 'utf8');

    // ── Маршрут — ровно теми строками, что стоят в bootstrap/runtime.ts ──────
    const deps = {
      store,
      appDataDir: appData,
      gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
    };
    // Ровно тем же ответом, что и `bootstrap/runtime.ts`: маршрут отдаёт не
    // только окружение, но и модель прогона с приёмом усилия (Т6), промпт
    // контура и наши слои (Т8). Урезанный здесь ответ зеленел бы на панели,
    // которая эти поля потеряла, — и ровно так эта проверка полдня показывала
    // «слои не доезжают» на панели, где они доезжали.
    const runRoute = (origin, asked = '') => {
      const decision = resolveRunRoute(deps, origin, asked);
      if (!decision.routed) return { env: {} };
      return {
        env: decision.env,
        model: decision.model,
        effort: decision.effort,
        ...(decision.systemPrompt ? { systemPrompt: decision.systemPrompt } : {}),
        ...(decision.layers ? { layers: decision.layers } : {}),
      };
    };

    const chatRuns = new ChatRunRegistry();
    chatRuns.setPlatformRouting(runRoute);

    // ── 1. Чат с отмеченной галочкой ─────────────────────────────────────────
    const startedChat = chatRuns.start(
      'live-chat',
      { prompt: 'привет', cwd: chatDir, configDir },
      { origin: 'chat' },
    );
    check(startedChat, 'прогон чата принят реестром');
    const chat = await waitForDump(chatDir);
    check(Boolean(chat), 'фальшивый CLI запустился и выгрузил своё окружение');

    if (chat) {
      check(
        chat.env.get('ANTHROPIC_BASE_URL') === `http://127.0.0.1:${port}/${CONTOUR}`,
        `адрес живого шлюза в окружении процесса: ${chat.env.get('ANTHROPIC_BASE_URL')}`,
      );
      check(
        chat.env.get('ANTHROPIC_AUTH_TOKEN') === PLACEHOLDER_KEY,
        `вместо ключа — заглушка: ${chat.env.get('ANTHROPIC_AUTH_TOKEN')}`,
      );
      check(
        chat.env.get('ANTHROPIC_MODEL') === MODEL,
        `модель управляемого профиля: ${chat.env.get('ANTHROPIC_MODEL')}`,
      );
      // Окружение сервера уцелело: адрес — ДОБАВКА, а не замена. Без PATH
      // фальшивый CLI не нашёлся бы вовсе, но своё имя он видит и в argv —
      // поэтому проверяем то, что панель ему не клала.
      check(chat.env.has('PATH') || chat.env.has('Path'), 'PATH процесса на месте: это добавка');
      check(!chat.raw.includes(SECRET), 'настоящего ключа контура в окружении процесса нет');
      // Аудит MD-06: преамбулу контура можно было править, а до процесса она не
      // доезжала. Сверка — с файлом, который CLI получил флагом: решение маршрута
      // не знает, что реестр и раннер из него донесли.
      const copy = join(chatDir, SYSTEM_PROMPT_COPY);
      const sent = existsSync(copy) ? readFileSync(copy, 'utf8') : '';
      const agent = promptText(appData, 'contour-agent').trim();
      const preamble = promptText(appData, 'contour-preamble').trim();
      check(sent.includes(agent), 'CLI получил файлом промпт агента через контур');
      check(
        sent.includes(preamble) && sent.indexOf(preamble) > sent.indexOf(agent),
        'следом за ним в том же файле — преамбула контура',
      );
    }

    check(
      readFileSync(settingsPath, 'utf8') === settingsBefore,
      'файл настроек CLI не изменился ни на байт',
    );
    check(
      !readFileSync(settingsPath, 'utf8').includes('ANTHROPIC_BASE_URL'),
      'адрес шлюза в файл настроек не записан',
    );

    // ── 2. Снятая галочка — и застрявший в параметрах адрес прошлой жизни ────
    // Так выглядит продолжение остановленного прогона: параметры приходят
    // старые. Реестр обязан пересобрать маршрут, а не унаследовать его.
    const startedGroup = chatRuns.start(
      'live-group',
      {
        prompt: 'привет',
        cwd: groupDir,
        configDir,
        platformEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/stale-contour' },
      },
      { origin: 'groups' },
    );
    check(startedGroup, 'прогон группы принят реестром');
    const group = await waitForDump(groupDir);
    check(Boolean(group), 'фальшивый CLI запустился и во втором прогоне');
    if (group) {
      check(
        !group.env.has('ANTHROPIC_BASE_URL'),
        `у снятой галочки адреса шлюза нет вовсе: ${group.env.get('ANTHROPIC_BASE_URL') ?? '—'}`,
      );
      check(!group.raw.includes('stale-contour'), 'адрес прошлой жизни прогона не пережил старт');
    }

    // ── 2а. Прогон со СВОИМ выбором модели и глубины (Т6) ────────────────────
    // Тот самый случай, ради которого Т6 и делалась: человек выбрал «sonnet» в
    // шапке чата. Имя панельное, контур его не знает, а уезжает оно флагом
    // `--model`, который сильнее адресной переменной. Здесь проверяется argv
    // РЕАЛЬНОГО процесса: решение маршрута об этом не говорит ничего.
    const askedDir = mkdtempSync(join(tmpdir(), 'cc-t6-asked-'));
    writePlatform(store, { ...platform, consumers: ['chat'], modelMap: { sonnet: MODEL } });
    chatRuns.start(
      'live-asked',
      { prompt: 'привет', cwd: askedDir, configDir, model: 'sonnet', effort: 'high' },
      { origin: 'chat' },
    );
    const asked = await waitForDump(askedDir);
    check(Boolean(asked), 'фальшивый CLI запустился и у прогона со своим выбором модели');
    if (asked) {
      const argv = asked.env.get(ARGV_KEY) ?? '';
      check(argv.includes(`--model ${MODEL}`), `в argv модель контура: ${argv}`);
      // Именно это и было дырой Т3: панельное имя доезжало до контура как есть.
      check(!argv.includes('sonnet'), `панельного имени в argv нет: ${argv}`);
      // compromise: no-effort — глубину контур не принимает, и флага быть не
      // должно вовсе: «--effort» уехал бы платной просьбой, которую никто не
      // выполнит.
      check(!argv.includes('--effort'), `глубина не отправлена: ${argv}`);
    }
    rmSync(askedDir, { recursive: true, force: true });

    // ── 2а'. Понижённая ступень: полное имя модели и журнал понижений ──────────
    // Ступень разделения и веера уезжает РАЗВЁРНУТЫМ именем (`claude-sonnet-5`),
    // а человек пишет карту семейством («sonnet»). Строка карты обязана сработать
    // и для полного имени — иначе «модель на группу» молча уходила в модель
    // контура по умолчанию. И журнал понижений обязан записать модель, которой
    // прогон ШЁЛ, а не имя из шапки (ревью Т6, m8): по нему считают, окупается ли
    // понижение.
    const MAPPED = 'qwen2.5:14b';
    const loweredDir = mkdtempSync(join(tmpdir(), 'cc-t6-lowered-'));
    const journaled = [];
    chatRuns.setLoweredJournal((record) => journaled.push(record));
    writePlatform(store, { ...platform, consumers: ['chat'], modelMap: { sonnet: MAPPED } });
    chatRuns.start(
      'live-lowered',
      { prompt: 'привет', cwd: loweredDir, configDir, model: 'claude-sonnet-5', effort: 'medium' },
      { origin: 'chat', lowered: { model: 'claude-sonnet-5', effort: 'medium' } },
    );
    const lowered = await waitForDump(loweredDir);
    check(Boolean(lowered), 'фальшивый CLI запустился и у понижённой ступени');
    if (lowered) {
      const argv = lowered.env.get(ARGV_KEY) ?? '';
      check(
        argv.includes(`--model ${MAPPED}`),
        `строка карты «sonnet» переводит полное имя: ${argv}`,
      );
    }
    for (let i = 0; i < 40 && journaled.length === 0; i += 1) await wait(250);
    const record = journaled.find((item) => item.chatId === 'live-lowered');
    check(
      record?.model === MAPPED && record?.effort === '',
      `журнал понижений пишет модель контура и не пишет глубину: ${JSON.stringify(record && { model: record.model, effort: record.effort })}`,
    );
    rmSync(loweredDir, { recursive: true, force: true });

    // ── 2б. Наши слои (Т8): снятое доезжает до argv, а брокер прав — переживает ──
    // `layers.test.ts` проверяет, ЧТО панель решила; что из решения доехало до
    // процесса — видно только здесь. Порядок флагов тоже проверяется: брокер
    // прав приезжает своим `--mcp-config`, и встать он обязан ПОСЛЕ
    // `--strict-mcp-config`, иначе каждый запрос разрешения станет молчаливым
    // отказом посреди работы агента.
    const layersDir = mkdtempSync(join(tmpdir(), 'cc-t8-layers-'));
    writePlatform(store, {
      ...platform,
      consumers: ['chat'],
      rules: {
        platform: defaultPlatformRules(),
        // Общий выключатель снят — значит снято всё, какими бы ни были частные.
        ours: { ...defaultOurRules(), enabled: false },
      },
    });
    chatRuns.start(
      'live-layers',
      {
        prompt: 'привет',
        cwd: layersDir,
        configDir,
        appendSystemPrompt: 'ДОПИСКА ПАНЕЛИ',
        permissionPrompt: { runId: 'live-layers', baseUrl: 'http://127.0.0.1:1' },
      },
      { origin: 'chat' },
    );
    const dropped = await waitForDump(layersDir);
    check(Boolean(dropped), 'фальшивый CLI запустился и у прогона со снятыми слоями');
    if (dropped) {
      const argv = dropped.env.get(ARGV_KEY) ?? '';
      // Кавычки вокруг значения ставит не панель, а оболочка Windows: запятая в
      // `project,local` для `cmd.exe` — разделитель, и без кавычек флаг уехал бы
      // половиной. Поэтому проверяется обе формы, а не дословная строка.
      check(
        /--setting-sources "?project,local"?/.test(argv),
        `личные правила, хуки и права сняты флагом: ${argv}`,
      );
      check(argv.includes('--disable-slash-commands'), 'скиллы сняты своим флагом');
      check(argv.includes('--strict-mcp-config'), 'MCP-серверы сняты своим флагом');
      check(
        !argv.includes('--append-system-prompt'),
        'дописки панели к системному промпту в запуске нет вовсе',
      );
      // Порядок этих двух флагов не решает НИЧЕГО, и прежняя проверка
      // (`--mcp-config` строго после `--strict-mcp-config`) охраняла свойство,
      // которого у CLI нет: `check-run-layers.mjs` запускает настоящий `claude` в
      // обратном порядке, и брокер там жив (ревью Т8, MINOR-3). Важно другое и
      // проверяется именно оно: снимая MCP, панель всё равно везёт конфиг
      // брокера — без него каждый запрос прав стал бы молчаливым отказом посреди
      // работы агента.
      check(
        argv.includes('--mcp-config'),
        `конфиг брокера прав едет вместе со снятием MCP: ${argv}`,
      );
    }
    rmSync(layersDir, { recursive: true, force: true });

    // И обратная сторона: слои на месте — ни одного флага снятия, дописка едет.
    const keptDir = mkdtempSync(join(tmpdir(), 'cc-t8-kept-'));
    writePlatform(store, { ...platform, consumers: ['chat'] });
    chatRuns.start(
      'live-kept',
      { prompt: 'привет', cwd: keptDir, configDir, appendSystemPrompt: 'ДОПИСКА ПАНЕЛИ' },
      { origin: 'chat' },
    );
    const kept = await waitForDump(keptDir);
    check(Boolean(kept), 'фальшивый CLI запустился и у прогона с полным набором слоёв');
    if (kept) {
      const argv = kept.env.get(ARGV_KEY) ?? '';
      check(
        !argv.includes('--setting-sources') &&
          !argv.includes('--disable-slash-commands') &&
          !argv.includes('--strict-mcp-config'),
        `флагов снятия нет ни одного: ${argv}`,
      );
      check(argv.includes('--append-system-prompt'), 'дописка панели едет как обычно');
    }
    rmSync(keptDir, { recursive: true, force: true });

    // И третья сторона, найденная ревью Т8 (MAJOR-4): прогон продолжают
    // СОХРАНЁННЫМИ параметрами (пауза дерева переживает и перезапуск панели).
    // Пока слой снимался затиранием текста дописки, возвращённая галочка уже
    // ничего не возвращала: восстанавливать было нечего, и человек получал агента
    // без инициатив и разделения при молчащей шапке чата.
    const resumeDir = mkdtempSync(join(tmpdir(), 'cc-t8-resume-'));
    const saved = chatRuns.describe('live-layers')?.options;
    check(Boolean(saved), 'снимок параметров прогона со снятым слоем сохранён');
    if (saved) {
      chatRuns.start('live-resume', { ...saved, cwd: resumeDir }, { origin: 'chat' });
      const resumed = await waitForDump(resumeDir);
      check(Boolean(resumed), 'фальшивый CLI запустился и у продолженного прогона');
      if (resumed) {
        const argv = resumed.env.get(ARGV_KEY) ?? '';
        check(
          argv.includes('--append-system-prompt'),
          `возвращённая галочка вернула дописку продолженному прогону: ${argv}`,
        );
      }
    }
    rmSync(resumeDir, { recursive: true, force: true });

    chatRuns.stopAll?.();

    // ── 3. Агент тестов — отдельное место запуска ────────────────────────────
    // Слои сняты намеренно: до ревью Т8 (MAJOR-3) строку с флагами у агента
    // тестов можно было удалить, и весь гейт оставался зелёным — «без наших
    // слоёв» означало бы «без них в чате, со всеми в тестах», а через контур
    // ходит модель среднего класса, которую полный `~/.claude` и топит.
    writePlatform(store, {
      ...platform,
      consumers: ['tests'],
      rules: {
        platform: defaultPlatformRules(),
        ours: { ...defaultOurRules(), enabled: false },
      },
    });
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, new Date().toISOString());

    const testRuns = new ProjectTestRunRegistry();
    testRuns.setPlatformRouting(() => runRoute('tests'));
    testRuns.start({ projectPath: project, mode: 'run' }, new Date().toISOString());

    const tests = await waitForDump(project);
    check(Boolean(tests), 'фальшивый CLI запустился и у агента тестов');
    if (tests) {
      check(
        tests.env.get('ANTHROPIC_BASE_URL') === `http://127.0.0.1:${port}/${CONTOUR}`,
        `галочка «Тесты» доводит адрес до своего прогона: ${tests.env.get('ANTHROPIC_BASE_URL')}`,
      );
      check(!tests.raw.includes(SECRET), 'ключа контура нет и в окружении агента тестов');
      const argv = tests.env.get(ARGV_KEY) ?? '';
      check(
        /--setting-sources "?project,local"?/.test(argv) &&
          argv.includes('--disable-slash-commands') &&
          argv.includes('--strict-mcp-config'),
        `снятые слои доезжают и до агента тестов: ${argv}`,
      );
      // Модель маршрута — флагом, как у чата (ревью Т6, m9): переменная
      // окружения слабее `--model`, и полагаться на неё одну значило бы ждать,
      // пока кто-нибудь добавит флаг в обход перевода.
      check(
        argv.includes(`--model ${MODEL}`),
        `агент тестов получает модель контура флагом: ${argv}`,
      );
      check(!argv.includes('--effort'), `глубина агенту тестов не отправлена: ${argv}`);
    }
    testRuns.stopAll();

    // ── 4. Чат чужого CLI: галочка `foreign:<cli>` ───────────────────────────
    // Мастер показывает эту галочку наравне с остальными, и до правки ревью Т3
    // она была нарисованной: маршрут считался, а до запуска не доходил вовсе.
    const provider = getProvider(FOREIGN);
    const chats = new ProviderChatService();
    chats.setPlatformRouting(runRoute);
    writePlatform(store, { ...platform, consumers: [`foreign:${FOREIGN}`] });

    const onChat = createChat(appData, FOREIGN, { title: 'через контур', workdir: foreignDir });
    const sentOn = chats.send(
      appData,
      FOREIGN,
      onChat.id,
      { text: 'привет' },
      { provider, detect: () => true },
    );
    check(sentOn.ok, 'сообщение чужому CLI принято службой');
    const foreign = await waitForDump(foreignDir);
    check(Boolean(foreign), 'фальшивый чужой CLI запустился и выгрузил окружение');
    if (foreign) {
      const url = foreign.env.get('OPENAI_BASE_URL');
      check(
        url === `http://127.0.0.1:${port}/${CONTOUR}/v1`,
        `адрес шлюза в переменных чужого CLI: ${url ?? '—'}`,
      );
      check(!foreign.raw.includes(SECRET), 'ключа контура нет и в окружении чужого CLI');
    }

    // Снятая галочка у того же CLI — прогон идёт своим провайдером.
    writePlatform(store, { ...platform, consumers: ['chat'] });
    const offChat = createChat(appData, FOREIGN, { title: 'мимо контура', workdir: foreignOffDir });
    chats.send(appData, FOREIGN, offChat.id, { text: 'привет' }, { provider, detect: () => true });
    const foreignOff = await waitForDump(foreignOffDir, 20);
    check(Boolean(foreignOff), 'фальшивый чужой CLI запустился и во втором разговоре');
    if (foreignOff) {
      check(
        !foreignOff.env.has('OPENAI_BASE_URL'),
        `со снятой галочкой адреса шлюза нет: ${foreignOff.env.get('OPENAI_BASE_URL') ?? '—'}`,
      );
    }
  } finally {
    await gateway.stop();
    await wait(500);
    for (const dir of [
      appData,
      configDir,
      bin,
      chatDir,
      groupDir,
      project,
      foreignDir,
      foreignOffDir,
    ]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }

  console.log(
    bad === 0
      ? '\nАдрес контура доходит до процесса прогона и только до него.'
      : `\nПроблем: ${bad}`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

// Типы снимаются самим Node с 22.18; на более старом 22.x нужен флаг, поэтому
// перезапускаем себя с ним, а не падаем с невнятным ERR_UNKNOWN_FILE_EXTENSION.
if (!process.features.typescript && !process.env.CC_RUN_ENV_RETRY) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CC_RUN_ENV_RETRY: '1' } },
  );
  process.exit(result.status ?? 1);
} else {
  await main();
}
