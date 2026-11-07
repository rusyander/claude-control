/**
 * Живое доказательство Т3: доходит ли адрес контура ДО ПРОЦЕССА прогона — и
 * только до него.
 *
 * Почему таблица `routing.test.ts` без этого прогона ничего не значит. Она
 * проверяет РЕШЕНИЕ (`resolveRunRoute` вернул такой-то объект) и зеленеет даже
 * тогда, когда между решением и процессом порвано всё: поле не перенесено в
 * сеанс ядра (`session-carry.ts`), ядро выбрало модель заново и иначе, оболочка
 * Windows съела переменную, реестр прогонов подставил старое значение. Здесь не
 * подменяется ничего, кроме самого CLI: на PATH кладётся фальшивый, который
 * печатает СВОЁ окружение и argv в файл, копирует файлы промпта и списка MCP и
 * выходит. Ни одного токена не тратится, сеть не трогается, стенд не нужен.
 *
 * Чат и группы идут так же, как у человека с этапа 10: реестр `ChatRunRegistry`
 * с исполнителем хода `CoreChatRun` (сборка `bootstrap/runtime/chat-wiring.ts`),
 * процесс поднимает НАСТОЯЩЕЕ ядро (`bootCore`) на доме хоста звеньев; своего
 * процесса CLI у панели нет. Папки прогонов — репозитории git с отметкой доверия
 * CLI во временном каталоге конфигурации (как проект человека), каталог
 * конфигурации ядра — тот же временный: настоящий `~/.claude` не читается.
 *
 * Что доказывается (каждая строка — обещание панели человеку):
 *   1. прогон чата с отмеченной галочкой «Чат» получает адрес звена ядра, заглушку
 *      ключа ровно под одним именем и модель контура флагом `--model`; промпт агента
 *      контура и преамбула доходят до процесса файлом;
 *   2. настоящий ключ контура в окружении процесса НЕ появляется;
 *   3. файл настроек CLI не меняется ни на байт — маршрут живёт в процессе;
 *   4. обязательный контур: прогон группы разделения со снятой галочкой всё равно
 *      идёт через звено ядра, а адрес из параметров прошлой жизни разговора
 *      (продолжение остановленного прогона) не переживает старт;
 *   5. агент тестов — задача ядра: галочка «Тесты» даёт ей маршрут контура
 *      (`coreContourRoutes`), и процесс, который поднимает ядро, получает адрес
 *      звена ядра без ключа контура;
 *   6. чат чужого CLI — ход реестра чата, как у Claude (этап 11, W3-17a: сборка сервера
 *      `wireChat` → `CoreChatRun`, `panel-chat-turn.mjs`): с отмеченной галочкой «Чат» процесс
 *      получает адрес звена ядра — в переменных, которые задокументированы у ЭТОГО CLI, — а со
 *      снятой при «по возможности» идёт своим входом CLI;
 *   7. снятые нами слои (Т8) доезжают до argv процесса флагами, сервер MCP человека
 *      пропадает из строгого списка ядра, дописка панели к системному промпту не
 *      уезжает в бриф, а конфиг брокера прав едет. Слои на месте — флагов снятия нет,
 *      сервер человека в списке, дописка в брифе. Что каждое поле переноса делает с
 *      настоящим CLI — живой тест переноса ядра,
 *      `apps/core/src/adapters/claude/claude.carry.live.integration.test.ts`;
 *   8. (помощник формы — вопрос ядра с этапа 10, F2b; его маршрут проверяют
 *      проверки `core-ask/one-shot`, здесь его нет);
 *   9. Kimi Code, Goose и OpenCode (X7) — ходы того же реестра чата: процесс получает
 *      адрес звена ядра в ТЕХ переменных, которые задокументированы у каждого
 *      (`packages/providers`), без ключа контура. Что настоящий CLI с этим окружением
 *      идёт в шлюз — `check-run-endpoint-cli.mjs`;
 *  10. запасной путь «Codex» (владелец 06.10): контур драйвером `openai-compat`
 *      с облачным адресом OpenAI ведёт тот же `claude` — чат, группа разделения
 *      и агент тестов получают адрес шлюза ядра, модель OpenAI и
 *      заглушку ключа; ни ключа, ни облачного адреса в процессе нет.
 *
 * Запуск: node tools/qa/check-platform-run-env.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

const isWindows = process.platform === 'win32';
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const SECRET = ['contour', 'live', 'key', '9f3c'].join('-');
const CONTOUR = 'live-company';
const MODEL = 'qwen2.5:7b';
/** Запасной путь «Codex»: модель OpenAI за совместимым шлюзом в облаке. */
const OPENAI_MODEL = 'gpt-5.1-codex';
/** Облачный адрес шлюза — поддельный: прогон до сети не доходит, шлюз не зовётся. */
const OPENAI_BASE = 'https://api.openai.example/v1';
const DUMP = 'cc-env-dump.txt';
/** Ключ строки с argv в том же файле: разбор у него общий с переменными. */
const ARGV_KEY = 'CC_ARGV';

/**
 * Убрать временную папку прогона. На Windows вышедший CLI (и его дети) держат
 * рабочую папку ещё секунды после остановки — EPERM здесь не про проверяемое
 * поведение, поэтому ждём до десяти секунд, а не отпустившую папку оставляем
 * в %TEMP% с предупреждением вместо падения всего прогона.
 */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`временная папка не удалена (${error.code ?? error.message}): ${dir}`);
  }
}
/** Копия системного промпта, снятая фальшивым CLI, пока файл панели ещё жив. */
const SYSTEM_PROMPT_COPY = 'cc-system-prompt.txt';
/** Копия дописки `--append-system-prompt-file`: на Windows дописка панели едет только файлом. */
const APPEND_PROMPT_COPY = 'cc-append-prompt.txt';
/** Копия `--mcp-config` сеанса ядра: строгий список MCP, в котором видно, доехал ли сервер человека. */
const MCP_CONFIG_COPY = 'cc-mcp-config.json';
/**
 * Строка панели к системному промпту, которую путь ядра везёт сеансу (`appendOf` в
 * `session-carry.ts`): строка о тестах проекта. Собственная дописка панели к ядру не едет вовсе —
 * её место занимает бриф ядра, — поэтому слой «системный промпт» виден по этой строке: снятый, он
 * её убирает, возвращённый — возвращает.
 */
const PANEL_APPEND = 'ДОПИСКА ПАНЕЛИ';
/** Сервер MCP человека во временном `.claude.json`: снятые слои MCP обязаны его убрать. */
const PERSONAL_MCP = 'personal-mcp-qa';

/** Серверы строгого списка MCP, с которым ядро запустило процесс. */
function mcpServersOf(dir) {
  const file = join(dir, MCP_CONFIG_COPY);
  if (!existsSync(file)) return undefined;
  return Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {});
}
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

/**
 * Папка проекта — репозиторий git с одним коммитом: задачу ядро заводит только в рабочем дереве
 * git (оценка отказывает «not a git repository»), как и в настоящем проекте человека.
 */
function gitRepo(dir) {
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  trustDir(dir);
}

/** `.claude.json` временного каталога конфигурации — задаёт `main()`. */
let trustFile = '';

/**
 * Папка проекта, которой человек доверился в CLI (`projects[<путь>].hasTrustDialogAccepted`) — как
 * настоящий проект, где открывают чат. Без отметки ядро ведёт сеанс в режиме «observe»
 * (`--setting-sources ''`, F-86), и флаги наших слоёв в argv не видны вовсе: проверка смотрела
 * бы режим недоверенной копии, а не путь человека.
 */
function trustDir(dir) {
  if (!trustFile) return;
  const config = existsSync(trustFile) ? JSON.parse(readFileSync(trustFile, 'utf8')) : {};
  const key = realpathSync.native(dir).replaceAll('\\', '/');
  config.projects = { ...config.projects, [key]: { hasTrustDialogAccepted: true } };
  writeFileSync(trustFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Выгрузка процесса, который поднимает ядро: задача ядра идёт в своей копии проекта (рабочее
 * дерево git рядом с проектом), и CLI пишет выгрузку туда. Ищем в проекте и во всех его деревьях.
 */
async function waitForCoreDump(project, seconds = 60) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: project,
      encoding: 'utf8',
    });
    const trees = (listed.stdout ?? '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    for (const dir of [project, ...trees]) {
      const file = join(dir, DUMP);
      if (existsSync(file) && readFileSync(file, 'utf8').includes(`${ARGV_KEY}=`)) {
        return dumpOf(dir);
      }
    }
    await wait(250);
  }
  return undefined;
}

/** Тексты системного промпта и брифа, которые процесс получил файлами (копии фальшивого CLI). */
function promptFilesOf(dir) {
  return [SYSTEM_PROMPT_COPY, APPEND_PROMPT_COPY]
    .map((name) => join(dir, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/** Имена ключей с непустым значением в окружении процесса. */
function filledKeys(dump) {
  return [...dump.env.entries()]
    .filter(([key, value]) => /KEY|TOKEN/i.test(key) && value.trim() !== '')
    .map(([key]) => key);
}

/**
 * Ядро кладёт заглушку звена ровно под одно имя ключа Anthropic, прочие имена гасит пустыми, чтобы
 * унаследованное не уехало; что это не ключ контура — отдельная строка (`SECRET` во всём окружении).
 */
function placeholderOnly(dump) {
  const filled = filledKeys(dump);
  return (
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((key) => filled.includes(key)).length === 1
  );
}

/** Текст обёртки npm (`<имя>.cmd`) — та же фикстура, на которой ядро проверяет свой разбор. */
let npmCmdShim;

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
 *
 * На Windows — обёртка npm (`<имя>.cmd` → `node <скрипт> %*`), как у настоящей установки:
 * ядро без оболочки запускает только её (`exec-resolve.ts`, иная `.cmd` — отказ), а панель
 * разворачивает её так же. Выгрузка пишется одним разом, строкой argv в конце.
 */
function fakeCli(bin, name) {
  if (isWindows) {
    const script = `${name}-dump.cjs`;
    writeFileSync(
      join(bin, script),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        // Разовые вызовы ядра (`--version` замера базы, `--help`) — не прогон: ответ и выход.
        "if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }",
        "if (args.includes('--help')) process.exit(0);",
        'const here = (file) => path.join(process.cwd(), file);',
        `const copies = { '--system-prompt-file': '${SYSTEM_PROMPT_COPY}', '--append-system-prompt-file': '${APPEND_PROMPT_COPY}', '--mcp-config': '${MCP_CONFIG_COPY}' };`,
        'args.forEach((arg, i) => {',
        '  if (copies[arg] && args[i + 1]) try { fs.copyFileSync(args[i + 1], here(copies[arg])); } catch {}',
        '});',
        'const lines = Object.entries(process.env).map(([key, value]) => `${key}=${value}`);',
        `lines.push('${ARGV_KEY}=' + args.join(' '));`,
        `fs.writeFileSync(here('${DUMP}'), lines.join('\\n') + '\\n');`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(bin, `${name}.cmd`), npmCmdShim(script));
    return;
  }
  const scan =
    `prev=""\nfor a in "$@"; do\n` +
    `  [ "$prev" = "--system-prompt-file" ] && cp "$a" "$PWD/${SYSTEM_PROMPT_COPY}"\n` +
    `  [ "$prev" = "--append-system-prompt-file" ] && cp "$a" "$PWD/${APPEND_PROMPT_COPY}"\n` +
    `  [ "$prev" = "--mcp-config" ] && cp "$a" "$PWD/${MCP_CONFIG_COPY}"\n` +
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
  const { AppStore } = await import('../../apps/server/src/lib/app-store/app-store.ts');
  const { coreGateway } = await import('./core-gateway.mjs');
  const { writePlatform, writeToken } =
    await import('../../apps/server/src/domains/platform/store/store.ts');
  const { buildManagedProfile } =
    await import('../../apps/server/src/domains/platform/apply/profile.ts');
  const { resolveRunRoute, runRouteOf } =
    await import('../../apps/server/src/domains/platform/routing/routing.ts');
  const { promptText } = await import('../../apps/server/src/domains/prompts/prompts.ts');
  const { ChatRunRegistry } =
    await import('../../apps/server/src/domains/chat/ChatRunRegistry/ChatRunRegistry.ts');
  const { CoreChatRun } = await import('../../apps/server/src/domains/chat/core-run/core-run.ts');
  const { carryOfTestsRoute } =
    await import('../../apps/server/src/domains/chat/core-run/session-carry.ts');
  const { createCoreChatBook } =
    await import('../../apps/server/src/domains/chat/core-run/core-chat-book.ts');
  const { ProjectTestRunRegistry } =
    await import('../../apps/server/src/domains/project-tests/runs/runs.ts');
  const { createGroup, upsertCase } =
    await import('../../apps/server/src/domains/project-tests/store/store.ts');
  const { panelChatRuns, startPanelChat } = await import('./panel-chat-turn.mjs');
  const { bootCore } = await import('../../apps/core/src/bootstrap/boot.ts');
  const { createCoreCaller } = await import('../../apps/server/src/domains/core-ask/core-ask.ts');
  const { createCoreChatPort } =
    await import('../../apps/server/src/domains/chat/core-run/core-chat-port.ts');
  const { chatContourRoutes, coreContourRoutes } =
    await import('../../apps/server/src/domains/platform/routing/core-contour.ts');
  const { reapCoreSessions } = await import('./throwaway-stand.mjs');
  ({ npmCmdShim } = await import('../../apps/core/src/platform/__fixtures__/shims.ts'));

  const { defaultOurRules, defaultPlatformRules } =
    await import('../../packages/contracts/src/platform.ts');

  const appData = mkdtempSync(join(tmpdir(), 'cc-t3-appdata-'));
  const configDir = mkdtempSync(join(tmpdir(), 'cc-t3-config-'));
  // Каталог конфигурации CLI для ЯДРА тоже временный: ядро в этом же процессе, и без переменной
  // сеанс читал настоящий `~/.claude` человека (его CLAUDE.md уезжал в бриф фальшивого CLI).
  process.env.CLAUDE_CONFIG_DIR = configDir;
  trustFile = join(configDir, '.claude.json');
  writeFileSync(
    trustFile,
    `${JSON.stringify({ mcpServers: { [PERSONAL_MCP]: { command: 'node', args: ['--version'] } } })}\n`,
    'utf8',
  );
  const bin = mkdtempSync(join(tmpdir(), 'cc-t3-bin-'));
  const chatDir = mkdtempSync(join(tmpdir(), 'cc-t3-chat-'));
  const groupDir = mkdtempSync(join(tmpdir(), 'cc-t3-group-'));
  const project = mkdtempSync(join(tmpdir(), 'cc-t3-project-'));
  const foreignDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-'));
  const foreignOffDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-off-'));
  const foreignBestDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-best-'));
  const foreignOwnDir = mkdtempSync(join(tmpdir(), 'cc-t3-foreign-own-'));
  const localDir = mkdtempSync(join(tmpdir(), 'cc-t3-local-'));
  // Конфиги Kimi и Goose — временные: проверка читает их (настройка мимо контура)
  // и не должна зависеть от конфигов человека на этой машине.
  const cliHomes = mkdtempSync(join(tmpdir(), 'cc-t3-cli-homes-'));
  const endpointDirs = Object.fromEntries(
    ['kimi', 'goose', 'opencode'].map((id) => [id, mkdtempSync(join(tmpdir(), `cc-t3-${id}-`))]),
  );
  // Запасной путь «Codex»: у каждого места запуска — своя папка выгрузки.
  const codexDirs = Object.fromEntries(
    ['chat', 'group', 'project'].map((id) => [
      id,
      // Имя короткое: длинное пёстрое имя папки маска секретов журнала ядра принимает за
      // ключ, и задача ядра теряет свой каталог (отдельный дефект ядра, не предмет этой проверки).
      mkdtempSync(join(tmpdir(), `cc-cx-${id}-`)),
    ]),
  );
  // Шлюз держит ядро (этап 10); проверка смотрит окружение прогона, не расход.
  const gateway = coreGateway();
  /** Ядро рядом с хостом звеньев (`bootCore`); поднимается после шлюза. */
  let core;

  try {
    fakeCli(bin, 'claude');
    fakeCli(bin, FOREIGN);
    for (const id of ['kimi', 'goose', 'opencode']) fakeCli(bin, id);
    // На Windows панель берёт нативный `<имя>.exe` из ЛЮБОЙ папки PATH раньше
    // `.cmd`-обёртки (resolveWindowsExecutable), и установленный у человека goose
    // перебивал бы фальшивый. Папки с настоящими копиями фальшивых CLI убираем.
    const realCopy = (dir) =>
      isWindows &&
      ['kimi', 'goose', 'opencode'].some((id) =>
        ['.exe', '.com'].some((ext) => existsSync(join(dir, `${id}${ext}`))),
      );
    const rest = (process.env.PATH ?? '')
      .split(isWindows ? ';' : ':')
      .filter((dir) => dir && !realCopy(dir));
    process.env.PATH = [bin, ...rest].join(isWindows ? ';' : ':');

    // ── Состояние панели: контур сохранён, активен, ключ на месте ────────────
    const store = new AppStore(appData);
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    store.updateSettings({ activePlatformId: CONTOUR });

    // Шлюз поднимается НАСТОЯЩИЙ: порт маршруту отдаёт живой слушатель, а не
    // запись в настройках — именно это отличие и стоило Т1 одного отказа.
    await gateway.start({ appDataDir: appData });
    const port = gateway.status().port;
    check(gateway.status().running && port > 0, `шлюз поднят на порту ${port}`);

    // Агент тестов — задача ядра (этап 10, F6): его процесс поднимает ядро, а контур едет
    // разрешённым набором задачи (`coreContourRoutes`). Ядро — настоящее, на доме того же
    // хоста звеньев, с исполнителем задач: подменять его значило бы проверять подмену.
    const bootRunEnvCore = () =>
      bootCore({ home: gateway.home(), build: 'run-env-qa', panelAppData: appData });
    core = await bootRunEnvCore();
    /** Ядро заново на том же доме: так ядро перечитывает политику контура панели. */
    const restartCore = async () => {
      await core.stop();
      core = await bootRunEnvCore();
    };
    const corePort = createCoreChatPort(createCoreCaller(() => gateway.home()));
    /** Прогон тестов, как его запускает маршрут панели (`run-routes.ts`). */
    const startTests = (registry, projectPath) => {
      registry.setCorePort(corePort);
      return registry.start(
        { projectPath, mode: 'run' },
        new Date().toISOString(),
        undefined,
        undefined,
        {
          appData,
          routes: coreContourRoutes(store, 'tests', 'claude'),
        },
      );
    };
    /** Адрес звена ядра: свой порт хоста звеньев, не порт шлюза человека. */
    const isHopLink = (url) => {
      const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(url ?? '');
      return Boolean(match) && Number(match[1]) !== port;
    };

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
    // Ровно тем же ответом, что и `bootstrap/runtime/runtime.ts`: маршрут отдаёт не
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

    // Реестр чата собран ровно как в `bootstrap/runtime/chat-wiring.ts`: исполнитель хода — задача
    // ядра (`CoreChatRun`, этап 10), своего процесса CLI у панели нет; маршрут контура — по галочке
    // «Чат» свежим на каждую задачу. Процесс поднимает ядро на этом же доме.
    const chatBook = createCoreChatBook(join(appData, 'core-chat-book.json'));
    const chatRoutes = (asked) => coreContourRoutes(store, 'chat', 'claude', asked);
    const chatRuns = new ChatRunRegistry(
      () => new CoreChatRun({ port: corePort, book: chatBook, routes: chatRoutes }),
    );
    chatRuns.setPlatformRouting(runRoute);
    chatRuns.setWorkspaceNote(() => PANEL_APPEND);
    for (const dir of [chatDir, groupDir, ...Object.values(codexDirs)]) gitRepo(dir);

    // ── 1. Чат с отмеченной галочкой ─────────────────────────────────────────
    const startedChat = chatRuns.start(
      'live-chat',
      { prompt: 'привет', cwd: chatDir, configDir },
      { origin: 'chat' },
    );
    check(startedChat, 'прогон чата принят реестром');
    const chat = await waitForCoreDump(chatDir);
    check(Boolean(chat), 'фальшивый CLI запустился (процесс ядра) и выгрузил своё окружение');

    if (chat) {
      check(
        isHopLink(chat.env.get('ANTHROPIC_BASE_URL')),
        `адрес звена ядра в окружении процесса: ${chat.env.get('ANTHROPIC_BASE_URL')}`,
      );
      check(
        placeholderOnly(chat),
        `вместо ключа — заглушка звена ровно под одним именем (заполнены: ${filledKeys(chat).join(', ') || '—'})`,
      );
      check(
        (chat.env.get(ARGV_KEY) ?? '').includes(`--model ${MODEL}`),
        `модель контура флагом: ${(chat.env.get(ARGV_KEY) ?? '').slice(0, 200)}`,
      );
      // Окружение сервера уцелело: адрес — ДОБАВКА, а не замена. Без PATH
      // фальшивый CLI не нашёлся бы вовсе, но своё имя он видит и в argv —
      // поэтому проверяем то, что панель ему не клала.
      check(chat.env.has('PATH') || chat.env.has('Path'), 'PATH процесса на месте: это добавка');
      check(!chat.raw.includes(SECRET), 'настоящего ключа контура в окружении процесса нет');
      // Аудит MD-06: преамбулу контура можно было править, а до процесса она не
      // доезжала. Сверка — с файлом, который CLI получил флагом: решение маршрута
      // не знает, что реестр и раннер из него донесли.
      // Процесс ядра несёт промпт файлом брифа (`--append-system-prompt-file`), панельный —
      // `--system-prompt-file`; сверяется то, что дошло до процесса любым из двух.
      const sent = promptFilesOf(chatDir);
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
    const group = await waitForCoreDump(groupDir);
    check(Boolean(group), 'фальшивый CLI запустился и во втором прогоне');
    if (group) {
      // Контур обязательный (решение 02.11): снятая галочка не уводит прогон мимо контура —
      // адрес звена ядра свежий, а не унаследованный из параметров прошлой жизни.
      check(
        isHopLink(group.env.get('ANTHROPIC_BASE_URL')),
        `обязательный контур, галочка снята: адрес звена ядра, собранный заново: ${group.env.get('ANTHROPIC_BASE_URL') ?? '—'}`,
      );
      check(!group.raw.includes('stale-contour'), 'адрес прошлой жизни прогона не пережил старт');
    }

    // ── 2а. Прогон со СВОИМ выбором модели и глубины (Т6) ────────────────────
    // Тот самый случай, ради которого Т6 и делалась: человек выбрал «sonnet» в
    // шапке чата. Имя панельное, контур его не знает, а уезжает оно флагом
    // `--model`, который сильнее адресной переменной. Здесь проверяется argv
    // РЕАЛЬНОГО процесса: решение маршрута об этом не говорит ничего.
    const askedDir = mkdtempSync(join(tmpdir(), 'cc-t6-asked-'));
    gitRepo(askedDir);
    writePlatform(store, { ...platform, consumers: ['chat'], modelMap: { sonnet: MODEL } });
    chatRuns.start(
      'live-asked',
      { prompt: 'привет', cwd: askedDir, configDir, model: 'sonnet', effort: 'high' },
      { origin: 'chat' },
    );
    const asked = await waitForCoreDump(askedDir);
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
    removeDir(askedDir);

    // ── 2а'. Понижённая ступень: полное имя модели и журнал понижений ──────────
    // Ступень разделения и веера уезжает РАЗВЁРНУТЫМ именем (`claude-sonnet-5`),
    // а человек пишет карту семейством («sonnet»). Строка карты обязана сработать
    // и для полного имени — иначе «модель на группу» молча уходила в модель
    // контура по умолчанию. И журнал понижений обязан записать модель, которой
    // прогон ШЁЛ, а не имя из шапки (ревью Т6, m8): по нему считают, окупается ли
    // понижение.
    const MAPPED = 'qwen2.5:14b';
    const loweredDir = mkdtempSync(join(tmpdir(), 'cc-t6-lowered-'));
    gitRepo(loweredDir);
    const journaled = [];
    chatRuns.setLoweredJournal((record) => journaled.push(record));
    writePlatform(store, { ...platform, consumers: ['chat'], modelMap: { sonnet: MAPPED } });
    chatRuns.start(
      'live-lowered',
      { prompt: 'привет', cwd: loweredDir, configDir, model: 'claude-sonnet-5', effort: 'medium' },
      { origin: 'chat', lowered: { model: 'claude-sonnet-5', effort: 'medium' } },
    );
    const lowered = await waitForCoreDump(loweredDir);
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
    removeDir(loweredDir);

    // ── 2б. Наши слои (Т8): снятое доезжает до argv, а брокер прав — переживает ──
    // `layers.test.ts` проверяет, ЧТО панель решила; что из решения доехало до
    // процесса — видно только здесь. Порядок флагов тоже проверяется: брокер
    // прав приезжает своим `--mcp-config`, и встать он обязан ПОСЛЕ
    // `--strict-mcp-config`, иначе каждый запрос разрешения станет молчаливым
    // отказом посреди работы агента.
    const layersDir = mkdtempSync(join(tmpdir(), 'cc-t8-layers-'));
    gitRepo(layersDir);
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
        permissionPrompt: { runId: 'live-layers', baseUrl: 'http://127.0.0.1:1' },
      },
      { origin: 'chat' },
    );
    const dropped = await waitForCoreDump(layersDir);
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
      // `--strict-mcp-config` у сеанса ядра стоит всегда (свой список задачи); снятие видно по
      // самому списку: сервера человека в нём нет.
      const servers = mcpServersOf(layersDir);
      check(
        argv.includes('--strict-mcp-config') &&
          servers !== undefined &&
          !servers.includes(PERSONAL_MCP),
        `MCP-серверы человека сняты (в строгом списке: ${servers?.join(', ') ?? 'нет копии'})`,
      );
      // Бриф ядра едет файлом всегда (`--append-system-prompt-file`), поэтому смотрится его текст.
      const brief = promptFilesOf(layersDir);
      check(
        brief.length > 0 && !brief.includes(PANEL_APPEND),
        `дописки панели к системному промпту в запуске нет вовсе (бриф ${brief.length} знаков)`,
      );
      // Порядок этих двух флагов не решает НИЧЕГО, и прежняя проверка
      // (`--mcp-config` строго после `--strict-mcp-config`) охраняла свойство,
      // которого у CLI нет: настоящий `claude` с обратным порядком держал брокер живым
      // (ревью Т8, MINOR-3); строгий список MCP ядра у живого CLI проверяет
      // `claude.carry.live.integration.test.ts`. Важно другое и
      // проверяется именно оно: снимая MCP, панель всё равно везёт конфиг
      // брокера — без него каждый запрос прав стал бы молчаливым отказом посреди
      // работы агента.
      check(
        argv.includes('--mcp-config'),
        `конфиг брокера прав едет вместе со снятием MCP: ${argv}`,
      );
    }
    removeDir(layersDir);

    // И обратная сторона: слои на месте — ни одного флага снятия, дописка едет.
    const keptDir = mkdtempSync(join(tmpdir(), 'cc-t8-kept-'));
    gitRepo(keptDir);
    writePlatform(store, { ...platform, consumers: ['chat'] });
    chatRuns.start('live-kept', { prompt: 'привет', cwd: keptDir, configDir }, { origin: 'chat' });
    const kept = await waitForCoreDump(keptDir);
    check(Boolean(kept), 'фальшивый CLI запустился и у прогона с полным набором слоёв');
    if (kept) {
      const argv = kept.env.get(ARGV_KEY) ?? '';
      // `--setting-sources user` при своём каталоге конфигурации — не снятие
      // слоя, а изоляция песочницы: «user» и есть её каталог.
      // Снятие слоёв контура — только `local` / `project,local`. `--strict-mcp-config` у сеанса
      // ядра стоит всегда — слой MCP на месте, если сервер человека есть в строгом списке.
      const sources = /--setting-sources (\S+)/.exec(argv)?.[1];
      const servers = mcpServersOf(keptDir);
      check(
        (sources === undefined || sources === 'user') &&
          !argv.includes('--disable-slash-commands') &&
          Boolean(servers?.includes(PERSONAL_MCP)),
        `флагов снятия нет ни одного, MCP человека в списке (${servers?.join(', ') ?? 'нет копии'}): ${argv}`,
      );
      check(promptFilesOf(keptDir).includes(PANEL_APPEND), 'дописка панели едет как обычно');
    }
    removeDir(keptDir);

    // И третья сторона, найденная ревью Т8 (MAJOR-4): прогон продолжают
    // СОХРАНЁННЫМИ параметрами (пауза дерева переживает и перезапуск панели).
    // Пока слой снимался затиранием текста дописки, возвращённая галочка уже
    // ничего не возвращала: восстанавливать было нечего, и человек получал агента
    // без инициатив и разделения при молчащей шапке чата.
    const resumeDir = mkdtempSync(join(tmpdir(), 'cc-t8-resume-'));
    gitRepo(resumeDir);
    const saved = chatRuns.describe('live-layers')?.options;
    check(Boolean(saved), 'снимок параметров прогона со снятым слоем сохранён');
    if (saved) {
      chatRuns.start('live-resume', { ...saved, cwd: resumeDir }, { origin: 'chat' });
      const resumed = await waitForCoreDump(resumeDir);
      check(Boolean(resumed), 'фальшивый CLI запустился и у продолженного прогона');
      if (resumed) {
        const argv = resumed.env.get(ARGV_KEY) ?? '';
        check(
          promptFilesOf(resumeDir).includes(PANEL_APPEND),
          `возвращённая галочка вернула дописку продолженному прогону: ${argv.slice(0, 200)}`,
        );
      }
    }
    removeDir(resumeDir);

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
    gitRepo(project);
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, new Date().toISOString());

    const testRuns = new ProjectTestRunRegistry();
    // Ровно та же проводка, что в `bootstrap/runtime/runtime.ts`: слои маршрута `tests` агенту
    // тестов на Claude — полями сеанса ядра (G13). Без неё проверка смотрела бы прогон без слоя.
    testRuns.setLayerCarry(() => carryOfTestsRoute(runRoute('tests')));
    check(
      coreContourRoutes(store, 'tests', 'claude')?.[0]?.route.id === `gateway:${CONTOUR}`,
      'галочка «Тесты» даёт задаче ядра маршрут контура',
    );
    startTests(testRuns, project);

    const tests = await waitForCoreDump(project);
    check(Boolean(tests), 'фальшивый CLI запустился и у агента тестов (процесс ядра)');
    if (!tests) {
      const view = testRuns.get(project);
      console.log(
        `      прогон: ${JSON.stringify({ ...view, log: view?.log?.slice(-800) }).slice(0, 1500)}`,
      );
    }
    if (tests) {
      check(
        isHopLink(tests.env.get('ANTHROPIC_BASE_URL')),
        `галочка «Тесты» доводит до прогона адрес звена ядра: ${tests.env.get('ANTHROPIC_BASE_URL')}`,
      );
      check(!tests.raw.includes(SECRET), 'ключа контура нет и в окружении агента тестов');
      const argv = tests.env.get(ARGV_KEY) ?? '';
      // Набор «наш» снят: перенос слоя сужает источники настроек сеанса ядра — среди них нет
      // `user`, а MCP человека отрезан строгим списком задачи (`--strict-mcp-config`).
      const sources = /--setting-sources (\S*)/.exec(argv)?.[1];
      check(
        sources !== undefined && !sources.includes('user') && argv.includes('--strict-mcp-config'),
        `слоёв человека у агента тестов нет (источники «${sources ?? '—'}»): ${argv.slice(0, 240)}`,
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

    // ── 4. Чат чужого CLI: галочка «Чат» ─────────────────────────────────────
    // Чат чужого CLI — ход того же реестра чата, что у Claude (этап 11, W3-17a): сборка сервера
    // `wireChat` → `CoreChatRun`, CLI — активный провайдер, маршрут — галочка «Чат» активного
    // контура (`set-route` до `set-cli`). Своя книга разговоров у сборки — в своём каталоге, чтобы
    // не затирать книгу реестра Claude выше (обе пишут файл целиком).
    const wiredData = join(appData, 'wired-chat');
    const wiredRuns = await panelChatRuns({ appData: wiredData, store, coreHome: gateway.home() });
    const foreignKeys = [];
    /** Хвост журнала задачи ядра — почему процесс не поднялся. */
    const journalTail = (taskId, count = 12) => {
      try {
        const dir = join(gateway.home(), 'tasks', taskId);
        const name = readdirSync(dir).find((file) => file.endsWith('.jsonl'));
        return readFileSync(join(dir, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .slice(-count)
          .map((line) => {
            const row = JSON.parse(line);
            return `${row.kind} ${JSON.stringify(row.data).slice(0, 200)}`;
          });
      } catch (error) {
        return [`журнал не прочитан: ${error}`];
      }
    };
    /** Новый чат CLI так, как его заводит панель (отправка, продолжение, перенос). */
    const startForeign = async (cli, dir) => {
      gitRepo(dir);
      const outcome = await startPanelChat(wiredRuns, {
        appData: wiredData,
        store,
        cli,
        cwd: dir,
        prompt: 'привет',
      }).catch((error) => ({ ok: false, code: 'core-unreachable', message: String(error) }));
      if (outcome.ok) foreignKeys.push(outcome.key);
      else console.log(`      ${cli}: ход отказан: ${outcome.code} ${outcome.message}`);
      return outcome;
    };
    /** Адрес звена ядра с путём диалекта (`/v1`): свой порт хоста звеньев, не шлюз человека. */
    const hopBase = (url) => {
      const match = /^(http:\/\/127\.0\.0\.1:\d+)(\/.*)?$/.exec(url ?? '');
      return Boolean(match) && isHopLink(match[1]);
    };
    writePlatform(store, { ...platform, consumers: ['chat'] });

    const sentOn = await startForeign(FOREIGN, foreignDir);
    check(sentOn.ok, 'чат чужого CLI заведён задачей ядра с маршрутом контура');
    const foreign = sentOn.ok ? await waitForCoreDump(foreignDir) : undefined;
    check(Boolean(foreign), 'фальшивый чужой CLI запустился (процесс ядра) и выгрузил окружение');
    if (foreign) {
      const url = foreign.env.get('OPENAI_BASE_URL');
      check(hopBase(url), `адрес звена ядра в переменных чужого CLI: ${url ?? '—'}`);
      check(!foreign.raw.includes(SECRET), 'ключа контура нет и в окружении чужого CLI');
    }

    // Аренда маршрута (`route-lease`) — то, что ядро взяло для сеанса; упоминания входа CLI в
    // разрешённом наборе до сужения контуром выбором не являются.
    const leasesOf = (sent) =>
      sent.ok ? journalTail(sent.taskId, 400).filter((line) => line.includes('"route-lease"')) : [];

    // Снятая галочка при ОБЯЗАТЕЛЬНОМ контуре (решение 02.11): каждый потребитель идёт через
    // контур. Ядро и так сводит набор к шлюзу (L1, `contourNarrow`), но без маршрута панели шаблон
    // модели оставался `*`, сеанс отказывал «needs a concrete model» — галочка ничего не решала, а
    // прогон падал. Теперь сервер задаёт маршрут контура с моделью контура и при снятой галочке,
    // и процесс ОБЯЗАН подняться с адресом звена ядра — «процесса нет» больше не зелёное.
    // Снята именно «Чат»: другая галочка («Тесты») стоит и чату ничего не решает.
    writePlatform(store, { ...platform, consumers: ['tests'] });
    check(
      chatContourRoutes(store, FOREIGN)?.[0]?.route.id === `gateway:${CONTOUR}`,
      'обязательный контур: со снятой галочкой сервер всё равно задаёт чату чужого CLI маршрут контура',
    );
    const sentOff = await startForeign(FOREIGN, foreignOffDir);
    const foreignOff = sentOff.ok ? await waitForCoreDump(foreignOffDir, 30) : undefined;
    const offUrl = foreignOff?.env.get('OPENAI_BASE_URL') ?? '';
    const offLeases = leasesOf(sentOff);
    if (sentOff.ok && !foreignOff)
      for (const line of journalTail(sentOff.taskId)) console.log(`      ${line}`);
    check(
      Boolean(foreignOff) && hopBase(offUrl) && !foreignOff.raw.includes(SECRET),
      `обязательный контур, галочка снята: процесс поднялся через звено ядра без ключа контура: ${
        foreignOff ? `адрес ${offUrl || '—'}` : 'процесса нет'
      }`,
    );
    check(
      offLeases.length > 0 && offLeases.every((line) => line.includes(`gateway:${CONTOUR}`)),
      `обязательный контур, галочка снята: арендован только маршрут контура (аренд ${offLeases.length})`,
    );

    // «По возможности»: галочка решает. Снятая — маршрута контура нет, задача идёт набором ядра по
    // умолчанию, то есть своим входом CLI, и адреса звена в процессе нет. Политику контура ядро
    // читает один раз на загрузку (`boot-core.ts`), поэтому смена режима — с перезапуском ядра.
    // «Чат» — галочка разговоров Claude: чат qwen ведёт его собственная `foreign:qwen`
    // (`chatConsumerOf`), и стоящая «Чат» его в контур уводить не должна.
    writePlatform(store, { ...platform, mode: 'best-effort', consumers: ['chat', 'tests'] });
    await restartCore();
    check(
      chatContourRoutes(store, FOREIGN) === undefined,
      '«по возможности»: галочка qwen снята («Чат» стоит) — сервер маршрута контура чату qwen не задаёт',
    );
    const sentBest = await startForeign(FOREIGN, foreignBestDir);
    const foreignBest = sentBest.ok ? await waitForCoreDump(foreignBestDir, 30) : undefined;
    const bestUrl = foreignBest?.env.get('OPENAI_BASE_URL') ?? '';
    const bestLeases = leasesOf(sentBest);
    if (sentBest.ok && !foreignBest)
      for (const line of journalTail(sentBest.taskId)) console.log(`      ${line}`);
    check(
      Boolean(foreignBest) && !hopBase(bestUrl) && !foreignBest.raw.includes(SECRET),
      `«по возможности», галочка снята: процесс идёт своим входом CLI, без адреса звена: ${
        foreignBest ? `адрес ${bestUrl || '—'}` : 'процесса нет'
      }`,
    );
    check(
      bestLeases.length > 0 && bestLeases.every((line) => line.includes('cli-login:')),
      `«по возможности», галочка снята: арендован маршрут входа CLI (аренд ${bestLeases.length})`,
    );

    // «По возможности», стоит только `foreign:qwen` (так её ставит подключение локальной модели):
    // чат qwen идёт через контур, хотя «Чат» снята. Режим тот же — ядро не перезапускается.
    writePlatform(store, { ...platform, mode: 'best-effort', consumers: [`foreign:${FOREIGN}`] });
    check(
      chatContourRoutes(store, FOREIGN)?.[0]?.route.id === `gateway:${CONTOUR}`,
      '«по возможности», стоит только галочка qwen: сервер задаёт чату qwen маршрут контура',
    );
    const sentOwn = await startForeign(FOREIGN, foreignOwnDir);
    const foreignOwn = sentOwn.ok ? await waitForCoreDump(foreignOwnDir, 30) : undefined;
    const ownUrl = foreignOwn?.env.get('OPENAI_BASE_URL') ?? '';
    const ownLeases = leasesOf(sentOwn);
    if (sentOwn.ok && !foreignOwn)
      for (const line of journalTail(sentOwn.taskId)) console.log(`      ${line}`);
    check(
      Boolean(foreignOwn) && hopBase(ownUrl) && !foreignOwn.raw.includes(SECRET),
      `«по возможности», галочка qwen: процесс поднялся через звено ядра без ключа контура: ${
        foreignOwn ? `адрес ${ownUrl || '—'}` : 'процесса нет'
      }`,
    );
    check(
      ownLeases.length > 0 && ownLeases.every((line) => line.includes(`gateway:${CONTOUR}`)),
      `«по возможности», галочка qwen: арендован только маршрут контура (аренд ${ownLeases.length})`,
    );
    writePlatform(store, { ...platform, consumers: ['chat'] });
    // Разделы ниже ведут Claude: активный провайдер — как до этого раздела.
    store.updateSettings({ provider: 'claude' });
    await restartCore();

    // ── 6а. Запасной путь «Codex»: совместимый шлюз в облаке OpenAI ──────────
    // Решение владельца 06.10: без отдельного движка — контур с облачным
    // OpenAI-совместимым адресом гонит тот же `claude` на модель OpenAI. Драйвер
    // и адрес шлюза в окружение прогона не входят: процесс видит только шлюз
    // ядра, модель — флагом. Провод к такому шлюзу — `check-platform-wire`, §13.
    const openai = {
      ...platform,
      driver: 'openai-compat',
      baseUrl: OPENAI_BASE,
      consumers: ['chat', 'groups', 'tests', 'assistant'],
    };
    writePlatform(store, openai);
    const openaiProfile = buildManagedProfile(
      openai,
      { enabled: true, port, forceStream: true },
      OPENAI_MODEL,
    );
    store.updateSettings({
      provider: 'claude',
      endpointProfiles: [openaiProfile],
      assistantEndpointId: openaiProfile.id,
    });
    gitRepo(codexDirs.project);
    createGroup(codexDirs.project, 'gui', 'GUI');
    upsertCase(
      codexDirs.project,
      'gui',
      { title: 'Вход', steps: ['открыть'] },
      new Date().toISOString(),
    );
    const codexTests = new ProjectTestRunRegistry();
    const surfaces = [
      {
        name: 'чат',
        consumer: 'chat',
        dir: codexDirs.chat,
        start: () =>
          chatRuns.start(
            'codex-chat',
            { prompt: 'привет', cwd: codexDirs.chat, configDir },
            { origin: 'chat' },
          ),
      },
      {
        name: 'группа разделения',
        consumer: 'groups',
        dir: codexDirs.group,
        start: () =>
          chatRuns.start(
            'codex-group',
            { prompt: 'привет', cwd: codexDirs.group, configDir },
            { origin: 'groups' },
          ),
      },
      {
        name: 'агент тестов',
        consumer: 'tests',
        dir: codexDirs.project,
        core: true,
        start: () => startTests(codexTests, codexDirs.project),
      },
    ];
    for (const surface of surfaces) {
      surface.start();
      // Все три места запуска — задачи ядра (чат и группа — реестром чата с `CoreChatRun`).
      const dump = await waitForCoreDump(surface.dir);
      check(Boolean(dump), `codex: ${surface.name} — фальшивый claude запустился (процесс ядра)`);
      if (!dump && surface.core) {
        const view = codexTests.get(surface.dir);
        console.log(
          `      прогон: ${JSON.stringify({ ...view, log: view?.log?.slice(-800) }).slice(0, 1500)}`,
        );
      }
      if (!dump) continue;
      const base = dump.env.get('ANTHROPIC_BASE_URL');
      check(isHopLink(base), `codex: ${surface.name} — адрес звена ядра: ${base ?? '—'}`);
      const argv = dump.env.get(ARGV_KEY) ?? '';
      check(
        argv.includes(`--model ${OPENAI_MODEL}`),
        `codex: ${surface.name} — модель OpenAI флагом: ${argv.slice(0, 160)}`,
      );
      check(
        placeholderOnly(dump),
        `codex: ${surface.name} — вместо ключа заглушка (заполнены: ${filledKeys(dump).join(', ') || '—'})`,
      );
      check(!dump.raw.includes(SECRET), `codex: ${surface.name} — ключа контура в окружении нет`);
      check(
        !dump.raw.includes('api.openai.example'),
        `codex: ${surface.name} — облачного адреса в процессе нет, только шлюз`,
      );
    }
    codexTests.stopAll();

    // ── 6б. Локальная модель (L1): окно сервера доходит до процесса Claude ────
    // Без этих переменных Claude Code считает окно незнакомой модели 200 тысяч,
    // не сжимает историю вовремя, а сервер молча обрезает начало запроса (разбор
    // 13.10: входы 134–173 тысячи токенов при окне 131072). Окно здесь — то, что
    // отдаёт сервис моделей, а не константа в коде; сжатие по окну бьёт и
    // `autoCompactWindow` из настроек человека. Дисциплина локальной модели едет
    // допиской даже при режиме набора «глобальные», когда плагин не подключён.
    {
      const { localRunEnv } = await import('../../apps/server/src/domains/local-models/run-env.ts');
      const { localPlatformSettings, LOCAL_DRIVER } =
        await import('../../apps/server/src/domains/local-models/connect.ts');
      const { KitService } = await import('../../apps/server/src/domains/kit/service.ts');
      const LOCAL_ID = 'local-ollama';
      const LOCAL_MODEL = 'qwen3.6:27b-coding';
      const LOCAL_CTX = 65_536;
      const localPlatform = {
        ...platform,
        id: LOCAL_ID,
        driver: LOCAL_DRIVER,
        // Слои — те, с которыми панель заводит контур локальной модели: полный
        // набор по умолчанию (L6, 15.10), облегчённый только по выбору человека.
        rules: localPlatformSettings({
          baseUrl: 'http://127.0.0.1:11435',
          model: LOCAL_MODEL,
          title: 't',
          consumers: ['chat'],
        }).rules,
        baseUrl: 'http://127.0.0.1:11435/v1',
        consumers: ['chat'],
        toolShim: false,
        contourPrompt: false,
        defaultModel: LOCAL_MODEL,
      };
      const settingsBefore6b = store.getSettings();
      writePlatform(store, localPlatform);
      writeToken(appData, LOCAL_ID, SECRET);
      store.updateSettings({
        activePlatformId: LOCAL_ID,
        endpointProfiles: [
          buildManagedProfile(
            localPlatform,
            { enabled: true, port, forceStream: true },
            LOCAL_MODEL,
          ),
        ],
      });
      // Ядро держит маршруты контуров и политику с загрузки: новый активный контур — пересборка
      // шлюза и перезапуск ядра, как после правки контура в панели.
      await gateway.refresh();
      await restartCore();
      const localDeps = {
        ...deps,
        localRunEnv: (id) => (id === LOCAL_ID ? localRunEnv(LOCAL_CTX) : undefined),
      };
      const localKit = new KitService({
        appDataDir: appData,
        claudeDir: () => configDir,
        providers: () => [],
        legacyModes: () => ({ claude: 'global' }),
      });
      localKit.setMode('claude', 'global');
      // Те же строки, что стоят в `runRoute` сборки сервера (bootstrap/runtime/runtime.ts).
      const localRoute = (origin) => {
        const decision = resolveRunRoute(localDeps, origin);
        const route = runRouteOf(decision);
        if (!decision.routed) return route;
        const extras = localKit.runExtras({
          provider: 'claude',
          local: decision.platformId === LOCAL_ID,
          hasSources: false,
        });
        return extras.args.length || Object.keys(extras.env).length || extras.append
          ? { ...route, kit: extras }
          : route;
      };
      gitRepo(localDir);
      const localRuns = new ChatRunRegistry(
        () => new CoreChatRun({ port: corePort, book: chatBook, routes: chatRoutes }),
      );
      localRuns.setPlatformRouting(localRoute);
      localRuns.start(
        'local-chat',
        { prompt: 'привет', cwd: localDir, configDir },
        { origin: 'chat' },
      );
      const local = await waitForCoreDump(localDir);
      check(Boolean(local), 'локальная модель: фальшивый claude запустился');
      if (local) {
        for (const [key, value] of Object.entries(localRunEnv(LOCAL_CTX))) {
          check(
            local.env.get(key) === value,
            `локальная модель: ${key}=${local.env.get(key) ?? '—'} (ждали ${value})`,
          );
        }
        const base = local.env.get('ANTHROPIC_BASE_URL') ?? '';
        check(isHopLink(base), `локальная модель: адрес звена ядра рядом с окном: ${base || '—'}`);
        check(!local.raw.includes(SECRET), 'локальная модель: ключа контура в окружении нет');
        // Дисциплина — допиской: на Windows файлом, на остальных — аргументом.
        const copy = join(localDir, APPEND_PROMPT_COPY);
        const appended = existsSync(copy)
          ? readFileSync(copy, 'utf8')
          : (local.env.get(ARGV_KEY) ?? '');
        check(
          appended.includes('Local model discipline'),
          `локальная модель, режим «глобальные»: дисциплина доехала допиской (${appended.length} знаков)`,
        );
        // «Глобальные» набор не подключают; едет только накладка стражей, которых нет в слое
        // человека (`guardsOverlay`, `effective/guards`), — собранный набор режима нет.
        // Собственный плагин сеанса ядра (`<сеанс>/claude/plugin`: навыки и инструкции слоя ядра)
        // набором не является — он есть у каждого сеанса.
        const pluginDirs = [...(local.env.get(ARGV_KEY) ?? '').matchAll(/--plugin-dir (\S+)/g)]
          .map((match) => match[1])
          .filter((dir) => !/[\\/]sessions[\\/][^\\/]+[\\/]claude[\\/]plugin$/.test(dir));
        check(
          pluginDirs.every((dir) => /[\\/]effective[\\/]guards[\\/]/.test(dir)),
          `локальная модель, режим «глобальные»: набора нет, только стражи: ${pluginDirs.join(', ') || '—'}`,
        );
        // Полный набор по умолчанию (L6, 15.10): MCP-серверы и все инструменты едут,
        // как у облачного Claude; правила и скиллы человека тоже. Строгий список MCP у сеанса
        // ядра есть всегда — сервер человека обязан в нём быть.
        const localArgv = local.env.get(ARGV_KEY) ?? '';
        const localServers = mcpServersOf(localDir);
        check(
          Boolean(localServers?.includes(PERSONAL_MCP)),
          `локальная модель: MCP-серверы не сняты (полный набор по умолчанию; в списке: ${localServers?.join(', ') ?? 'нет копии'})`,
        );
        check(
          !localArgv.includes('--tools'),
          `локальная модель: инструменты без белого списка${localArgv.includes('--tools') ? `: ${localArgv}` : ''}`,
        );
        const localSources = /--setting-sources (\S*)/.exec(localArgv)?.[1];
        check(
          (localSources === undefined || localSources === 'user') &&
            !localArgv.includes('--disable-slash-commands'),
          `локальная модель: правила и скиллы человека не сняты (источники «${localSources ?? 'все'}»)`,
        );
      }
      localRuns.stopAll?.();
      // Чужой контур (первый чат этого прогона) окна локальной модели не получал.
      if (chat) {
        check(
          !chat.env.has('CLAUDE_CODE_AUTO_COMPACT_WINDOW') &&
            !chat.env.has('CLAUDE_CODE_MAX_CONTEXT_TOKENS'),
          'облачный контур: окна локальной модели в окружении нет',
        );
      }
      // Состояние для следующих разделов — как до этого.
      store.updateSettings({
        activePlatformId: settingsBefore6b.activePlatformId,
        endpointProfiles: settingsBefore6b.endpointProfiles,
      });
      await gateway.refresh();
      await restartCore();
    }

    // ── 7. Контур окружением прогона: Kimi Code, Goose, OpenCode (X7) ────────
    const savedEnv = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, APPDATA: process.env.APPDATA };
    process.env.KIMI_CODE_HOME = join(cliHomes, 'kimi-home');
    process.env.APPDATA = join(cliHomes, 'appdata');
    mkdirSync(process.env.KIMI_CODE_HOME, { recursive: true });
    // Чат каждого — ход того же реестра чата, что в §4: адрес — звено ядра в переменных,
    // задокументированных у этого CLI (`packages/providers`), ключ — заглушка звена.
    const sendTo = async (id, dir) => {
      writePlatform(store, { ...platform, consumers: ['chat'] });
      const sent = await startForeign(id, dir);
      check(sent.ok, `${id}: чат заведён задачей ядра с маршрутом контура`);
      return { sent, dump: sent.ok ? await waitForCoreDump(dir, 30) : undefined };
    };
    /** Заглушка звена вместо ключа: значение есть, и это не ключ контура. */
    const placeholderKey = (value) => Boolean(value) && !String(value).includes(SECRET);

    const kimi = (await sendTo('kimi', endpointDirs.kimi)).dump;
    check(Boolean(kimi), 'kimi: фальшивый CLI запустился и выгрузил окружение');
    if (kimi) {
      const url = kimi.env.get('KIMI_MODEL_BASE_URL') ?? '';
      check(
        hopBase(url) && url.endsWith('/v1'),
        `kimi: адрес звена ядра в KIMI_MODEL_BASE_URL: ${url || '—'}`,
      );
      check(kimi.env.get('KIMI_MODEL_PROVIDER_TYPE') === 'openai', 'kimi: провайдер openai');
      check(Boolean(kimi.env.get('KIMI_MODEL_NAME')), 'kimi: имя модели в окружении');
      check(
        placeholderKey(kimi.env.get('KIMI_MODEL_API_KEY')),
        'kimi: в KIMI_MODEL_API_KEY заглушка, а не ключ',
      );
      check(!kimi.raw.includes(SECRET), 'kimi: ключа контура в окружении нет');
    }

    const gooseChat = await sendTo('goose', endpointDirs.goose);
    const goose = gooseChat.dump;
    check(Boolean(goose), 'goose: фальшивый CLI запустился и выгрузил окружение');
    if (goose) {
      const host = goose.env.get('OPENAI_HOST');
      const path = goose.env.get('OPENAI_BASE_PATH') ?? '';
      check(hopBase(host), `goose: OPENAI_HOST — звено ядра: ${host ?? '—'}`);
      check(
        path.endsWith('v1/chat/completions'),
        `goose: OPENAI_BASE_PATH ведёт в chat/completions звена: ${path || '—'}`,
      );
      check(
        goose.env.get('GOOSE_PROVIDER') === 'openai' &&
          goose.env.get('GOOSE_SUBAGENT_PROVIDER') === 'openai',
        'goose: провайдер и провайдер субагентов — openai',
      );
      check(!goose.raw.includes(SECRET), 'goose: ключа контура в окружении нет');
    }

    const opencode = (await sendTo('opencode', endpointDirs.opencode)).dump;
    check(Boolean(opencode), 'opencode: фальшивый CLI запустился и выгрузил окружение');
    if (opencode) {
      // `set` cmd.exe и `env` печатают значение как есть: JSON одной строкой.
      let config;
      try {
        config = JSON.parse(opencode.env.get('OPENCODE_CONFIG_CONTENT') ?? '');
      } catch {
        config = undefined;
      }
      check(Boolean(config), 'opencode: OPENCODE_CONFIG_CONTENT — разбираемый JSON');
      const base = config?.provider?.contour?.options?.baseURL ?? '';
      check(
        hopBase(base) && base.endsWith('/v1'),
        `opencode: адрес звена ядра у провайдера contour: ${base || '—'}`,
      );
      check(
        JSON.stringify(config?.enabled_providers) === '["contour"]',
        'opencode: разрешён только провайдер contour',
      );
      check(!opencode.raw.includes(SECRET), 'opencode: ключа контура в окружении нет');
    }

    // Прежняя строка «Kimi с [secondary_model] в конфиге человека — отказ без процесса» снята:
    // сеанс ядра конфиг человека не читает (свой дом Kimi на сеанс), и настройке в нём уводить
    // прогон мимо контура неоткуда; обход канала судит ядро (`compat`, `bypass_setting`).
    // «Остановить» человека: прогон снимает задачу ядра (`CoreChatRun.stop` → `cancel`).
    for (const key of foreignKeys) wiredRuns.stop(key);
    store.updateSettings({ provider: 'claude' });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  } finally {
    // Ядро и его сеансы — до хоста звеньев: ядро зовёт звено до последнего хода.
    if (core) {
      await core.stop().catch(() => undefined);
      reapCoreSessions(gateway.home());
    }
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
      foreignBestDir,
      foreignOwnDir,
      localDir,
      cliHomes,
      ...Object.values(endpointDirs),
      ...Object.values(codexDirs),
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
