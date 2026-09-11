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
 *      снятой идёт своим провайдером.
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
const CONTOUR = 'live-enterprise-platform';
const MODEL = 'qwen2.5:7b';
const DUMP = 'cc-env-dump.txt';
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

/** Фальшивый CLI под этим именем: печатает окружение в рабочую папку прогона. */
function fakeCli(bin, name) {
  if (isWindows) {
    writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\nset > "%CD%\\${DUMP}"\r\nexit /b 0\r\n`);
    return;
  }
  writeFileSync(join(bin, name), `#!/bin/sh\nenv > "$PWD/${DUMP}"\nexit 0\n`, { mode: 0o755 });
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
  const { ChatRunRegistry } = await import('../../apps/server/src/domains/chat/ChatRunRegistry.ts');
  const { ProjectTestRunRegistry } =
    await import('../../apps/server/src/domains/project-tests/runs.ts');
  const { createGroup, upsertCase } =
    await import('../../apps/server/src/domains/project-tests/store.ts');
  const { ProviderChatService } =
    await import('../../apps/server/src/domains/provider-chat/ProviderChatService.ts');
  const { createChat } = await import('../../apps/server/src/domains/provider-chat/store.ts');
  const { getProvider } = await import('../../apps/server/src/providers/registry.ts');

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
    const runRoute = (origin) => {
      const decision = resolveRunRoute(deps, origin);
      return decision.routed ? { env: decision.env } : { env: {} };
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

    chatRuns.stopAll?.();

    // ── 3. Агент тестов — отдельное место запуска ────────────────────────────
    writePlatform(store, { ...platform, consumers: ['tests'] });
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
