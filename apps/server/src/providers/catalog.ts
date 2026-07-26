import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildCapabilities, type ConfigProvider } from './types.ts';

/**
 * ПЕРЕОПРЕДЕЛЕНИЯ КАТАЛОГОВ КОНФИГУРАЦИИ ЧЕРЕЗ ОКРУЖЕНИЕ.
 *
 * Уважаем ТОЛЬКО задокументированные переменные — угадывать переменные чужих CLI
 * нельзя, иначе панель начнёт читать/писать не туда:
 *  - Claude — `CLAUDE_CONFIG_DIR` (уже уважается в `lib/claude-paths.ts`);
 *  - Codex — `CODEX_HOME`: полный перенос каталога `~/.codex` (config.toml,
 *    AGENTS.md, всё остальное);
 *  - OpenCode — XDG: глобальный конфиг лежит в
 *    `$XDG_CONFIG_HOME/opencode`, и лишь при незаданной переменной — в
 *    `~/.config/opencode`. Для Linux это не косметика: у пользователя с
 *    заданным `XDG_CONFIG_HOME` путь `~/.config/opencode` попросту неверен;
 *  - OpenCode — `OPENCODE_CONFIG`: задокументированный перенос САМОГО ФАЙЛА
 *    конфигурации (не каталога) в произвольное место. Уважают его только разделы,
 *    которые правят `opencode.json` (MCP и права); `AGENTS.md` остаётся в
 *    каталоге конфигурации, потому что переменная задаёт именно файл конфига.
 *
 *  - Qwen Code — `QWEN_HOME`: задокументированный перенос каталога `~/.qwen`
 *    целиком (settings.json, QWEN.md, `.env`). Форк Gemini CLI переменную ДОБАВИЛ,
 *    у оригинала её нет.
 *
 * У Gemini, Continue, Goose, Cursor и Aider задокументированного переопределения
 * каталога нет → ничего не выдумываем, пути остаются от `os.homedir()` (у Goose
 * под Windows — от `%APPDATA%`, см. `gooseConfigDir`).
 *
 * Значение переменной прогоняется через `path.resolve`: относительный путь
 * становится абсолютным, а пустая/пробельная переменная игнорируется (иначе
 * `resolve('')` дал бы рабочий каталог сервера).
 */
function envDir(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? resolve(raw.trim()) : undefined;
}

/** Каталог конфигурации Codex: `CODEX_HOME`, иначе `~/.codex`. */
export function codexHome(): string {
  return envDir('CODEX_HOME') ?? join(homedir(), '.codex');
}

/**
 * Каталог конфигурации Qwen Code: `QWEN_HOME`, иначе `~/.qwen`.
 *
 * Переменная ЗАДОКУМЕНТИРОВАНА (docs/users/configuration/settings.md: «QWEN_HOME —
 * changes global configuration directory, default `~/.qwen`») и переносит каталог
 * целиком: settings.json, QWEN.md, `.env`. Это отличие форка от Gemini CLI, у
 * которого переопределения каталога нет вовсе.
 */
export function qwenHome(): string {
  return envDir('QWEN_HOME') ?? join(homedir(), '.qwen');
}

/**
 * Каталог данных Kimi Code: `KIMI_CODE_HOME`, иначе `~/.kimi-code`.
 *
 * Переменная ЗАДОКУМЕНТИРОВАНА («data locations»: `KIMI_CODE_HOME` переносит ВСЕ
 * данные Kimi — config.toml, AGENTS.md, mcp.json, сессии) и одинакова на всех ОС:
 * на Windows это `C:\Users\<имя>\.kimi-code`, отдельного пути под `%APPDATA%` у
 * этого CLI нет.
 */
export function kimiCodeHome(): string {
  return envDir('KIMI_CODE_HOME') ?? join(homedir(), '.kimi-code');
}

/**
 * Каталог конфигурации Continue — `~/.continue` (на Windows `%USERPROFILE%\.continue`).
 *
 * Задокументированного переопределения каталога у Continue НЕТ (в FAQ описан
 * только сам путь), поэтому переменных окружения здесь не выдумываем.
 */
export function continueHome(): string {
  return join(homedir(), '.continue');
}

/**
 * Каталог конфигурации Goose. Единственный провайдер, у которого путь под
 * Windows отличается НЕ ТОЛЬКО разделителями: документация задаёт
 * `~/.config/goose` на macOS/Linux и `%APPDATA%\Block\goose\config` на Windows.
 *
 * Платформа проверяется ФУНКЦИЕЙ, а не константой модуля: константа посчиталась
 * бы один раз при импорте, и проверить второй путь в тесте (без macOS/Linux под
 * рукой) было бы нечем. `APPDATA` не задана — падаем на её стандартное место,
 * иначе панель искала бы конфиг в корне диска.
 *
 * Задокументированного переопределения каталога у Goose нет (XDG в справочнике
 * конфигурации не заявлен), поэтому переменных здесь не выдумываем.
 */
export function gooseConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = envDir('APPDATA') ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Block', 'goose', 'config');
  }
  return join(homedir(), '.config', 'goose');
}

/** Каталог конфигурации OpenCode: `$XDG_CONFIG_HOME/opencode`, иначе `~/.config/opencode`. */
export function opencodeConfigDir(): string {
  return join(envDir('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'opencode');
}

/**
 * Файл конфигурации OpenCode: `OPENCODE_CONFIG` (задокументированный перенос
 * самого файла), иначе `opencode.json` в каталоге конфигурации. Значение
 * прогоняется через `path.resolve` — как у `CODEX_HOME`/`XDG_CONFIG_HOME`;
 * пустая/пробельная переменная игнорируется.
 */
export function opencodeConfigFile(): string {
  return envDir('OPENCODE_CONFIG') ?? join(opencodeConfigDir(), 'opencode.json');
}

/**
 * Провайдеры-данные (Codex, Gemini, Cursor, OpenCode, Aider).
 *
 * На этой фазе они ОБЪЯВЛЕНЫ (пути/инструкции — по карте плана), но их файлы не
 * читаются и не пишутся. Значения нужны только для отображения и гейтинга UI:
 * `capabilities` — карта статусов разделов, `status` = `experimental` (форматы
 * из документации, не проверены прогоном). Каждый `ready`-раздел появится лишь
 * когда под него будет реальный адаптер; пока максимум — `planned` (раздел «в
 * разработке», ничего не пишет).
 *
 * `paths` намеренно выбрасывает: адаптера файлов ещё нет, и панель не должна
 * случайно записать что-либо в чужой конфиг. Fail-closed по построению.
 */
function unimplementedPaths(id: string): () => never {
  return () => {
    throw new Error(
      `Провайдер «${id}» на этой фазе только объявлен: файловый адаптер не реализован, чтение/запись запрещены.`,
    );
  };
}

/** Codex (OpenAI): AGENTS.md + ~/.codex/config.toml (MCP в [mcp_servers]). */
const codexProvider: ConfigProvider = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  status: 'experimental',
  paths: unimplementedPaths('codex'),
  cli: { command: 'codex', windowsCommand: 'codex.cmd' },
  // Глобальный файл инструкций Codex задокументирован (~/.codex/AGENTS.md) →
  // раздел инструкций реально работает; override игнорируем (файл глобальный).
  instructionsFile: () => join(codexHome(), 'AGENTS.md'),
  // MCP-серверы Codex — таблицы [mcp_servers.<name>] в ~/.codex/config.toml.
  // Запись хирургическая (правится только регион mcp_servers), формат TOML.
  mcpConfig: { format: 'toml', path: () => join(codexHome(), 'config.toml') },
  // Переменные окружения Codex — таблица [shell_environment_policy.set] в том же
  // config.toml. Запись хирургическая: правится только ключ `set`, прочие ключи
  // политики (inherit/exclude/…) сохраняются по значениям.
  envConfig: { format: 'toml', path: () => join(codexHome(), 'config.toml') },
  // Права/аппрувы Codex — скалярные ключи КОРНЯ config.toml (`approval_policy` /
  // `sandbox_mode`). Запись хирургическая (upsertCodexRootScalar): правится только
  // сам корневой скаляр, одноимённые ключи внутри таблиц (`[profiles.x]`) не тронуты.
  permissionsConfig: { format: 'toml', path: () => join(codexHome(), 'config.toml') },
  // Проектный уровень Codex (COMMON-2): задокументированы проектный AGENTS.md в
  // корне и проектный `.codex/config.toml` (приоритет проект > профиль > глобаль).
  // Файл тот же формат TOML, что и глобальный, — адаптер переиспользуется целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'toml', relativePath: '.codex/config.toml' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.codex. Только проверка существования.
  configLocations: () => [codexHome()],
  // Ассистент Codex: API — OpenAI (ключ OPENAI_API_KEY), есть рабочий CLI (`codex`).
  // One-shot: `codex exec <prompt>` — неинтерактивный запуск (флаг задокументирован).
  assistant: {
    apiKind: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['exec', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Скрипты — раздел САМОЙ панели (произвольные файлы пользователя в её
    // каталоге hooks/), а не адаптер к чужому конфигу: ни CLI провайдера, ни его
    // формат тут не участвуют (COMMON-1). Поэтому `ready` у всех провайдеров;
    // claude-специфика раздела (песочница, отметка «вызывается хуком») гейтится
    // отдельно по своим возможностям `sandbox`/`hooks`.
    scripts: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог OpenAI (models.dev). Codex CLI работает с моделями OpenAI.
  modelVendors: ['openai'],
};

/** Gemini CLI: GEMINI.md + ~/.gemini/settings.json. */
const geminiProvider: ConfigProvider = {
  id: 'gemini',
  name: 'Gemini CLI',
  status: 'experimental',
  paths: unimplementedPaths('gemini'),
  cli: { command: 'gemini', windowsCommand: 'gemini.cmd' },
  // Глобальный файл инструкций Gemini задокументирован (~/.gemini/GEMINI.md).
  instructionsFile: () => join(homedir(), '.gemini', 'GEMINI.md'),
  // MCP-серверы Gemini — объект mcpServers в ~/.gemini/settings.json. Запись:
  // JSON.parse → правим только ключ mcpServers → JSON.stringify (прочее цело).
  mcpConfig: { format: 'json', path: () => join(homedir(), '.gemini', 'settings.json') },
  // Переменные окружения Gemini (GEMINI-3) — задокументированный файл `.env`:
  // глобальный `~/.gemini/.env`, проектный `<проект>/.gemini/.env`. Правка
  // ПОСТРОЧНАЯ: меняются только строки затронутых ключей, комментарии/пустые
  // строки/порядок целы, новые ключи дописываются в конец (см. lib/dotenv-file.ts).
  envConfig: { format: 'dotenv', path: () => join(homedir(), '.gemini', '.env') },
  // Права/аппрувы Gemini (GEMINI-2) — в том же settings.json: режим аппрувов
  // `general.defaultApprovalMode` (default | auto_edit | plan) и списки
  // инструментов `coreTools` (белый) / `excludeTools` (чёрный, приоритетнее).
  // Значение `yolo` панель НЕ пишет никогда: по докам это режим только для флага
  // CLI, а в settings.json он валит старт ошибкой enum (сервер отвечает 400).
  permissionsConfig: {
    format: 'gemini-json',
    path: () => join(homedir(), '.gemini', 'settings.json'),
  },
  // Проектный уровень Gemini (COMMON-2 + GEMINI-2/3): задокументированы проектный
  // GEMINI.md, `<проект>/.gemini/settings.json` (MCP и права — проектные настройки
  // перекрывают пользовательские) и `<проект>/.gemini/.env`. Форматы те же, что у
  // глобальных разделов, — адаптеры переиспользуются целиком.
  projectConfig: {
    instructions: 'GEMINI.md',
    mcp: { format: 'json', relativePath: '.gemini/settings.json' },
    env: { format: 'dotenv', relativePath: '.gemini/.env' },
    permissions: { format: 'gemini-json', relativePath: '.gemini/settings.json' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.gemini. Только проверка существования.
  configLocations: () => [join(homedir(), '.gemini')],
  // Ассистент Gemini: API — Google (ключи GEMINI_API_KEY / GOOGLE_API_KEY), есть
  // рабочий CLI (`gemini`). Обе стандартные переменные подхватываются автоматически.
  // One-shot: `gemini -p <prompt>` — неинтерактивный print-режим (флаг задокументирован).
  assistant: {
    apiKind: 'google',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // GEMINI-2: права — `general.defaultApprovalMode` + coreTools/excludeTools.
    permissions: 'ready',
    // GEMINI-3: переменные окружения — файл `.env` (глобальный и проектный).
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Google (models.dev).
  modelVendors: ['google'],
};

/**
 * Qwen Code: QWEN.md + `~/.qwen/settings.json` (форк Gemini CLI).
 *
 * ФОРК, НО НЕ КОПИЯ. Структура каталога и ключ `mcpServers` совпадают с Gemini —
 * эти адаптеры (`json`, `dotenv`, файл инструкций) переиспользуются целиком. А вот
 * ПРАВА разъехались, и брать у Gemini их нельзя:
 *  - режим аппрувов у Qwen — `tools.approvalMode` (у Gemini `general.defaultApprovalMode`);
 *  - списки инструментов — `permissions.allow` / `ask` / `deny` (у Gemini
 *    `coreTools`/`excludeTools`; у Qwen старые `tools.core`/`allowed`/`exclude`
 *    ПОМЕЧЕНЫ УСТАРЕВШИМИ и мигрируются в `permissions.*` — панель их не пишет).
 * Отсюда собственный формат `qwen-json`.
 *
 * Каталог конфигурации переносится переменной `QWEN_HOME` (см. `qwenHome()`).
 */
const qwenProvider: ConfigProvider = {
  id: 'qwen',
  name: 'Qwen Code',
  status: 'experimental',
  paths: unimplementedPaths('qwen'),
  cli: { command: 'qwen', windowsCommand: 'qwen.cmd' },
  // Глобальный файл инструкций (контекстный файл) задокументирован:
  // `~/.qwen/QWEN.md` — «you, across all your projects»; проектный — QWEN.md в
  // корне репозитория.
  instructionsFile: () => join(qwenHome(), 'QWEN.md'),
  // MCP-серверы Qwen — объект `mcpServers` в settings.json, форма как у Gemini
  // (command/args/env/cwd, url для SSE, httpUrl для streamable HTTP) → общий
  // JSON-адаптер без изменений.
  mcpConfig: { format: 'json', path: () => join(qwenHome(), 'settings.json') },
  // Переменные окружения — задокументированный `.env`: глобальный
  // `<QWEN_HOME>/.env`, проектный `<проект>/.qwen/.env` (он в порядке загрузки
  // ПЕРВЫЙ и рекомендован докой). Правка построчная, как у Gemini.
  envConfig: { format: 'dotenv', path: () => join(qwenHome(), '.env') },
  // Права/аппрувы — свой формат (см. комментарий выше): `tools.approvalMode` +
  // списки правил `permissions.allow` / `ask` / `deny`.
  permissionsConfig: {
    format: 'qwen-json',
    path: () => join(qwenHome(), 'settings.json'),
  },
  // Хуки Qwen (QWEN-1) — ключ КОРНЯ `hooks` в том же settings.json: событие →
  // массив групп с матчером и действиями. Панель ведёт действия типа `command`
  // (см. lib/qwen-hook.ts); таймаут там в МИЛЛИСЕКУНДАХ.
  hooksConfig: { format: 'qwen-json', path: () => join(qwenHome(), 'settings.json') },
  // Скиллы Qwen (QWEN-2) — папка на скилл со `SKILL.md`: личные
  // `~/.qwen/skills/`, проектные `<проект>/.qwen/skills/`. Обязательные поля
  // шапки те же два (`name`, `description`), прочие (`priority`, `paths`,
  // `user-invocable`, `disable-model-invocation`) панель сохраняет как чужие.
  skillsConfig: { format: 'skill-md-dir', dir: () => join(qwenHome(), 'skills') },
  // Проектный уровень: проектный QWEN.md в корне, `<проект>/.qwen/settings.json`
  // (MCP и права; проектные настройки перекрывают пользовательские) и
  // `<проект>/.qwen/.env`. Форматы те же, что у глобальных разделов.
  projectConfig: {
    instructions: 'QWEN.md',
    mcp: { format: 'json', relativePath: '.qwen/settings.json' },
    env: { format: 'dotenv', relativePath: '.qwen/.env' },
    permissions: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
    // Проектные хуки и скиллы задокументированы ровно там же, где проектные
    // настройки: `hooks` в `.qwen/settings.json` (док прямо говорит, что
    // проектные хуки требуют доверенной папки) и каталог `.qwen/skills/`.
    hooks: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
    skills: { format: 'skill-md-dir', relativeDir: '.qwen/skills' },
  },
  // Детект «конфиг найден» (Ф7): каталог конфигурации. Только проверка существования.
  configLocations: () => [qwenHome()],
  // Ассистент Qwen: модельное API — OpenAI-совместимое (OPENAI_API_KEY +
  // OPENAI_BASE_URL/OPENAI_MODEL), у ModelStudio/DashScope — DASHSCOPE_API_KEY.
  // One-shot: `qwen -p <промпт>` — задокументированный headless-режим.
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // Права: `tools.approvalMode` + `permissions.allow/ask/deny` (формат qwen-json).
    permissions: 'ready',
    // Переменные окружения — файл `.env` (глобальный и проектный).
    env: 'ready',
    chat: 'ready',
    // Проектный уровень: QWEN.md + `.qwen/settings.json` + `.qwen/.env`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Хуки (QWEN-1) — ключ `hooks` в settings.json; скиллы (QWEN-2) — каталог
    // `skills/` с папками SKILL.md. Оба формата разобраны по документации.
    skills: 'ready',
    hooks: 'ready',
    // Плагинов у Qwen Code документация не описывает → раздел скрыт.
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Alibaba (models.dev) — семейство Qwen.
  modelVendors: ['alibaba'],
};

/**
 * Continue: `~/.continue/config.yaml` (MCP) + `~/.continue/permissions.yaml` (права).
 *
 * ЧТО ВКЛЮЧЕНО — только подтверждённое документацией:
 *  - **MCP** (`mcp = ready`): ключ `mcpServers` в `config.yaml`. Форма СВОЯ и ни
 *    на кого не похожа — не «имя → запись», а СПИСОК записей с полем `name`
 *    внутри; транспорт задаётся `type` (`stdio` | `sse` | `streamable-http`),
 *    заголовки — в `requestOptions.headers`. Отсюда собственный формат
 *    `continue-yaml` (см. lib/continue-yaml.ts);
 *  - **права** (`permissions = ready`): ОТДЕЛЬНЫЙ файл `permissions.yaml` с тремя
 *    списками `allow` / `ask` / `exclude`. Режима-переключателя у Continue нет —
 *    это пятая модель раздела прав;
 *  - **переменные окружения** (`env = ready`): задокументированный `~/.continue/.env`
 *    (обычный dotenv), из которого берутся секреты `${{ secrets.ИМЯ }}`. Порядок
 *    поиска по документации: `<проект>/.env` → `<проект>/.continue/.env` →
 *    `~/.continue/.env` → окружение процесса; панель ведёт глобальный и проектный
 *    `.continue/.env`;
 *  - **чат** (`chat = ready`): задокументированный headless-режим `cn -p "<промпт>"`;
 *  - **файлы-блоки MCP** (`blockDir`): задокументированный каталог
 *    `.continue/mcpServers/` — каждый `*.yaml` в нём несёт свой список
 *    `mcpServers` под шапкой `name` / `version` / `schema: v1`. Continue грузит
 *    их вместе с `config.yaml`, поэтому раздел показывает и те, и другие, а
 *    правка идёт в тот файл, где запись лежит. Новые серверы панель по-прежнему
 *    кладёт в `config.yaml` — свой файл она не заводит. Каталог блоков есть и в
 *    проекте (`relativeBlockDir`), и глобально: документация описывает его в
 *    рабочей папке, глобальный `~/.continue/mcpServers` Continue сканирует тем
 *    же кодом — это ПОКА НЕ ПРОВЕРЕНО живьём (см. LIMITATIONS-PROVIDERS);
 *  - **проектный уровень** (`projects = ready`): `<проект>/.continue/rules/*.md`
 *    (каталог правил), `<проект>/.continue/mcpServers/mcp.json` (JSON-файл MCP в
 *    задокументированном каталоге блоков — форма `mcpServers` как у Claude
 *    Desktop/Cursor, её Continue подхватывает как есть) и `<проект>/.continue/.env`.
 *
 * ЧЕГО НЕТ: **глобальных инструкций** (`globalInstructions = unsupported`). У
 * Continue задокументирован ТОЛЬКО проектный каталог правил `.continue/rules`;
 * глобального файла инструкций нет, а ключ `rules` в config.yaml — разнородный
 * список (строка правила ИЛИ ссылка `uses:`), под который модели раздела нет.
 * Угадывать не станем.
 */
const continueProvider: ConfigProvider = {
  id: 'continue',
  name: 'Continue',
  status: 'experimental',
  paths: unimplementedPaths('continue'),
  // Бинарь CLI — `cn` (пакет @continuedev/cli).
  cli: { command: 'cn', windowsCommand: 'cn.cmd' },
  mcpConfig: {
    format: 'continue-yaml',
    path: () => join(continueHome(), 'config.yaml'),
    blockDir: () => join(continueHome(), 'mcpServers'),
  },
  envConfig: { format: 'dotenv', path: () => join(continueHome(), '.env') },
  permissionsConfig: {
    format: 'continue-yaml',
    path: () => join(continueHome(), 'permissions.yaml'),
  },
  projectConfig: {
    instructionsRules: { format: 'continue-md', relativeDir: '.continue/rules' },
    mcp: {
      format: 'json',
      relativePath: '.continue/mcpServers/mcp.json',
      relativeBlockDir: '.continue/mcpServers',
    },
    env: { format: 'dotenv', relativePath: '.continue/.env' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.continue. Только проверка существования.
  configLocations: () => [continueHome()],
  // Ассистент Continue: CLI логинится в аккаунт Continue либо работает по ключу
  // Anthropic; своего единого модельного API у панели тут нет → раннер `cli`.
  // One-shot: `cn -p "<промпт>"` — задокументированный headless-режим.
  assistant: {
    apiKind: 'anthropic',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'CONTINUE_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    // Глобального файла/каталога инструкций у Continue не задокументировано (см.
    // комментарий выше) → раздел скрыт, а не «в разработке».
    globalInstructions: 'unsupported',
    mcp: 'ready',
    permissions: 'ready',
    env: 'ready',
    chat: 'ready',
    // Проектный уровень: каталог правил `.md` + JSON-файл MCP + `.env`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
};

/**
 * Goose (Block): ОДИН файл `config.yaml` держит и MCP-серверы, и режим аппрувов,
 * а инструкции лежат рядом отдельным файлом `.goosehints`.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *  - каталог: `~/.config/goose` (macOS/Linux), `%APPDATA%\Block\goose\config`
 *    (Windows) — считает `gooseConfigDir()`;
 *  - MCP: ключ `extensions` — ОТОБРАЖЕНИЕ «имя → запись», тип задаёт `type`
 *    (`stdio` / `sse` / `streamable_http` — внешние серверы; `builtin` и прочие —
 *    встроенные расширения Goose, панель их не показывает и не трогает);
 *  - права: скалярный ключ КОРНЯ `GOOSE_MODE` (`auto`, `approve`,
 *    `smart_approve`, `chat`) — модель «один режим», как у Codex, без списков;
 *  - инструкции: `.goosehints` в каталоге конфигурации (глобальные, действуют во
 *    всех сессиях) и `<проект>/.goosehints` (проектные, перекрывают глобальные);
 *  - чат: `goose run --no-session -t "<промпт>"` — задокументированный
 *    неинтерактивный запуск (`--no-session` не плодит файлы сессий).
 *
 *  - пофайловые разрешения инструментов: `permission.yaml` рядом с config.yaml —
 *    ТОЛЬКО ПОКАЗ. Три уровня («Always allow» / «Ask before» / «Never allow») в
 *    документации есть, а формата самого файла НЕТ: он известен лишь из
 *    исходников CLI, и правило «чужой формат — только по документации» запрещает
 *    его писать. Панель показывает, что настроено, и отсылает к `goose configure`.
 *
 * ЧЕГО НЕТ: **переменных окружения** (`env = unsupported`). Своего `.env` Goose
 * не загружает: значения берутся из окружения процесса, а секреты — из связки
 * ключей ОС либо `secrets.yaml`, который панель вести не станет.
 */
const gooseProvider: ConfigProvider = {
  id: 'goose',
  name: 'Goose',
  status: 'experimental',
  paths: unimplementedPaths('goose'),
  cli: { command: 'goose', windowsCommand: 'goose.cmd' },
  instructionsFile: () => join(gooseConfigDir(), '.goosehints'),
  mcpConfig: { format: 'goose-yaml', path: () => join(gooseConfigDir(), 'config.yaml') },
  permissionsConfig: {
    format: 'goose-yaml',
    path: () => join(gooseConfigDir(), 'config.yaml'),
    // Пофайловые разрешения инструментов — ТОЛЬКО ПОКАЗ (см. ниже про формат).
    readOnlyToolPermissionsPath: () => join(gooseConfigDir(), 'permission.yaml'),
  },
  projectConfig: { instructions: '.goosehints' },
  configLocations: () => [gooseConfigDir()],
  // Своего модельного API у Goose нет: модель даёт провайдер, который настроен
  // внутри самого Goose, а ключ лежит в его связке ключей. Поэтому `none` +
  // запуск через CLI (подписка/настройка пользователя), без ключа в панели.
  assistant: {
    apiKind: 'none',
    apiKeyEnvVars: [],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['run', '--no-session', '-t', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    chat: 'ready',
    // Проектный уровень: только `<проект>/.goosehints` — проектного config.yaml
    // документация не описывает, выдумывать его не станем.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Своего `.env` у Goose нет (см. комментарий выше) → раздел скрыт.
    env: 'unsupported',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
};

/**
 * Kimi Code (Moonshot): всё лежит в одном каталоге данных `~/.kimi-code`
 * (переносится `KIMI_CODE_HOME`), но РАЗНЫМИ файлами — конфиг отдельно, MCP
 * отдельно, инструкции отдельно.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *  - инструкции: `<home>/AGENTS.md` (глобальные) и `<проект>/AGENTS.md` (его
 *    создаёт команда `/init` в корне проекта);
 *  - MCP: `<home>/mcp.json` и проектный `<проект>/.kimi-code/mcp.json` — обычный
 *    ключ `mcpServers` (`command`/`args`/`env`/`cwd`, у удалённого `url` +
 *    `headers`) → общий JSON-адаптер, адрес в `url`;
 *  - права: `config.toml` — режим `default_permission_mode` + массив таблиц
 *    `[[permission.rules]]` (`decision` + `pattern`), см. `lib/kimi-toml.ts`;
 *  - чат: `kimi -p "<промпт>"` — задокументированный неинтерактивный запуск
 *    (TUI не открывается, ответ идёт в stdout).
 *
 * ЧЕГО НЕТ: **переменных окружения** (`env = unsupported`). Своего `.env` Kimi не
 * загружает, а документированная карта `[providers.<имя>.env]` — это КЛЮЧИ
 * доступа к моделям; секреты панель в чужой конфиг не пишет (свои ключи она
 * держит в шифрованном хранилище). Хуки (`[[hooks]]`), скиллы (`skills/`) и
 * плагины (`plugins/`) у CLI есть, но их формат под панель не разбирался →
 * fail-closed, разделы скрыты.
 */
const kimiProvider: ConfigProvider = {
  id: 'kimi',
  name: 'Kimi Code',
  status: 'experimental',
  paths: unimplementedPaths('kimi'),
  cli: { command: 'kimi', windowsCommand: 'kimi.cmd' },
  instructionsFile: () => join(kimiCodeHome(), 'AGENTS.md'),
  // MCP — ОТДЕЛЬНЫЙ файл mcp.json (в config.toml лежат только таймауты `[mcp]`,
  // а не серверы). Форма стандартная, адрес удалённого сервера — `url`.
  mcpConfig: {
    format: 'json',
    jsonHttpUrlKey: 'url',
    path: () => join(kimiCodeHome(), 'mcp.json'),
  },
  permissionsConfig: { format: 'kimi-toml', path: () => join(kimiCodeHome(), 'config.toml') },
  // Хуки Kimi (KIMI-1) — массив таблиц `[[hooks]]` в том же config.toml:
  // событие + матчер + команда оболочки + таймаут В СЕКУНДАХ (1–600).
  hooksConfig: { format: 'kimi-toml', path: () => join(kimiCodeHome(), 'config.toml') },
  // Скиллы Kimi (KIMI-2) — папка на скилл со `SKILL.md`: `~/.kimi-code/skills/`.
  // CLI грузит их ещё и из `~/.agents/skills` (и из проектных `.kimi-code/skills`,
  // `.agents/skills`) — панель об этом сообщает, но туда ничего не пишет.
  // `description` у Kimi задокументирован как однострочная сводка до 240 знаков.
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(kimiCodeHome(), 'skills'),
    alsoLoadedFrom: () => [join(homedir(), '.agents', 'skills')],
    descriptionMax: 240,
  },
  // Плагины Kimi (KIMI-3) — ТОЛЬКО ЧТЕНИЕ: каталог `plugins/managed/<id>/` с
  // JSON-манифестом. Реестр `plugins/installed.json` в дереве каталогов
  // задокументирован, а его ФОРМА — нет; ставят и включают плагины командой
  // `/plugins` внутри CLI. Панель показывает установленное и не пишет ничего.
  pluginsConfig: {
    format: 'kimi-plugins',
    dir: () => join(kimiCodeHome(), 'plugins', 'managed'),
    registryPath: () => join(kimiCodeHome(), 'plugins', 'installed.json'),
  },
  // Проектный уровень: AGENTS.md в корне + `.kimi-code/mcp.json` (он сливается с
  // пользовательским, при совпадении имён побеждает проектный). Проектного
  // config.toml у Kimi НЕТ — документация говорит об этом прямо, поэтому и прав
  // на уровне проекта здесь не бывает.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'json', relativePath: '.kimi-code/mcp.json', jsonHttpUrlKey: 'url' },
    // Проектные скиллы задокументированы (`.kimi-code/skills/`); проектных хуков
    // не бывает — config.toml у Kimi ровно один, пользовательский.
    skills: { format: 'skill-md-dir', relativeDir: '.kimi-code/skills' },
  },
  configLocations: () => [kimiCodeHome()],
  // Ассистент: модельное API Kimi — OpenAI-совместимое (`base_url` вида
  // `https://api.kimi.com/coding/v1`), ключ в `KIMI_API_KEY`/`MOONSHOT_API_KEY`.
  // One-shot: `kimi -p <промпт>`.
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    chat: 'ready',
    // Проектный уровень: AGENTS.md + `.kimi-code/mcp.json`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Своего `.env` у Kimi нет (см. комментарий выше) → раздел скрыт.
    env: 'unsupported',
    // Хуки (KIMI-1) — `[[hooks]]` в config.toml; скиллы (KIMI-2) — каталог
    // `skills/`; плагины (KIMI-3) — список установленного, только чтение.
    skills: 'ready',
    hooks: 'ready',
    plugins: 'ready',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Moonshot AI (models.dev) — семейство Kimi.
  modelVendors: ['moonshotai'],
};

/**
 * Cursor: правила-КАТАЛОГ `~/.cursor/rules/*.mdc` + MCP в `~/.cursor/mcp.json`.
 *
 * ИНСТРУКЦИИ У CURSOR — ТРЕТЬЯ МОДЕЛЬ (CURSOR-1). По документации это не один
 * файл (как CLAUDE.md/AGENTS.md/GEMINI.md) и не список ссылок (как `read` у
 * Aider), а КАТАЛОГ файлов `.mdc`: глобальный `~/.cursor/rules/`, проектный
 * `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются
 * (`.cursor/rules/frontend/react.mdc`). Каждый файл — YAML-frontmatter с полями
 * `description` (строка), `globs` (шаблоны файлов/каталогов через запятую),
 * `alwaysApply` (булево: подключать в каждый разговор) — и markdown-тело.
 *
 * Обычный `.md` в каталоге правил Cursor ИГНОРИРУЕТ (нет frontmatter) — панель
 * показывает такие файлы отдельным списком и никогда их не правит.
 */
const cursorProvider: ConfigProvider = {
  id: 'cursor',
  name: 'Cursor',
  status: 'experimental',
  paths: unimplementedPaths('cursor'),
  cli: { command: 'cursor-agent', windowsCommand: 'cursor-agent.cmd' },
  // Правила Cursor — КАТАЛОГ ~/.cursor/rules с файлами `.mdc` (CURSOR-1).
  // `instructionsFile`/`instructionsList` у него не бывает: модель одна из трёх.
  instructionsRules: {
    format: 'cursor-mdc',
    dir: () => join(homedir(), '.cursor', 'rules'),
  },
  // MCP-серверы Cursor — глобальный файл ~/.cursor/mcp.json той же формы, что у
  // Claude/Gemini: ключ `mcpServers` → { command, args, env } (stdio) либо { url }
  // (удалённый). Формат json переиспользует общий JSON-адаптер; адрес удалённого
  // сервера у Cursor пишется в `url` (в отличие от gemini-приоритетного httpUrl).
  mcpConfig: {
    format: 'json',
    jsonHttpUrlKey: 'url',
    path: () => join(homedir(), '.cursor', 'mcp.json'),
  },
  // Права Cursor (CURSOR-2) — ключ `permissions` файла `~/.cursor/cli-config.json`:
  // ДВА списка правил (`allow` и `deny`, deny приоритетнее), режима-переключателя
  // нет. Файл общий с прочими настройками CLI (`version`, `editor`, …), поэтому
  // правится ТОЛЬКО ключ `permissions`, остальное сохраняется по значениям.
  // Переопределения каталога через переменную окружения документация раздела прав
  // НЕ заявляет → не выдумываем, путь от `os.homedir()` (как у mcp.json и rules).
  permissionsConfig: {
    format: 'cursor-json',
    path: () => join(homedir(), '.cursor', 'cli-config.json'),
  },
  // Проектный уровень Cursor (COMMON-2 + CURSOR-1 + CURSOR-2): задокументированы
  // проектный MCP `<проект>/.cursor/mcp.json` (та же форма, адрес удалённого
  // сервера в `url`), проектный КАТАЛОГ ПРАВИЛ `<проект>/.cursor/rules/*.mdc` —
  // тот же формат `.mdc`, что и у глобального каталога, поэтому адаптер
  // переиспользуется целиком, меняется только корень (и он перепроверяется
  // `isInsideProject`), — и проектные ПРАВА `<проект>/.cursor/cli.json`. Имя файла
  // прав в проекте ДРУГОЕ (`cli.json`, не `cli-config.json`), и держит он по
  // документации только права: путь взят из документации дословно.
  projectConfig: {
    instructionsRules: { format: 'cursor-mdc', relativeDir: '.cursor/rules' },
    mcp: { format: 'json', relativePath: '.cursor/mcp.json', jsonHttpUrlKey: 'url' },
    permissions: { format: 'cursor-json', relativePath: '.cursor/cli.json' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.cursor. Только проверка существования.
  configLocations: () => [join(homedir(), '.cursor')],
  // У Cursor нет собственного модельного API и запуск ассистента через CLI не
  // поддерживаем → ассистент unsupported (раннер всегда `none`).
  assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: false },
  capabilities: buildCapabilities({
    // CURSOR-1: правила Cursor — КАТАЛОГ ~/.cursor/rules/*.mdc (много файлов с
    // frontmatter). Формат подтверждён документацией и реализован собственной,
    // ТРЕТЬЕЙ моделью раздела (`instructionsRules`), а не редактором «один файл».
    globalInstructions: 'ready',
    mcp: 'ready',
    // CURSOR-2: права Cursor — ключ `permissions` (`allow`/`deny`) в
    // `cli-config.json`; восьмая модель раздела, без режима и без списка `ask`.
    permissions: 'ready',
    // Проектный уровень (COMMON-2 + CURSOR-1 + CURSOR-2): проектный MCP
    // `.cursor/mcp.json` тем же json-адаптером, проектный каталог правил
    // `.cursor/rules/*.mdc` тем же адаптером `.mdc`, что и глобальный, и
    // проектные права `.cursor/cli.json` тем же адаптером `cursor-json`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
  }),
};

/** OpenCode: AGENTS.md + opencode.json. */
const opencodeProvider: ConfigProvider = {
  id: 'opencode',
  name: 'OpenCode',
  status: 'experimental',
  paths: unimplementedPaths('opencode'),
  cli: { command: 'opencode', windowsCommand: 'opencode.cmd' },
  // Глобальный файл инструкций OpenCode — обычный markdown
  // ~/.config/opencode/AGENTS.md (тот же де-факто стандарт, что у Codex).
  instructionsFile: () => join(opencodeConfigDir(), 'AGENTS.md'),
  // MCP-серверы OpenCode — ключ `mcp` внутри ~/.config/opencode/opencode.json.
  // Форма ИНАЯ, чем у mcpServers: { type:'local', command:[cmd,...args],
  // environment } либо { type:'remote', url, headers }. Отдельный адаптер формата
  // `opencode-json`; правится только ключ `mcp`, прочие ключи файла ($schema,
  // model, agents, …) и неизвестные поля сервера (включая `enabled`) сохраняются.
  mcpConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
  },
  // Права OpenCode (OPENCODE-1) — ключ `permission` того же opencode.json:
  // уровень `allow` | `deny` | `ask` у задокументированных инструментов (`edit`,
  // `bash`, `webfetch`), а у `bash` вместо уровня допустима КАРТА ШАБЛОНОВ команд
  // (`{"*":"ask","git *":"allow","git push *":"deny"}`). Правится только ключ
  // `permission`; прочие ключи файла и не ведомые панелью записи внутри
  // `permission` сохраняются (см. lib/opencode-permission.ts).
  permissionsConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
  },
  // Хуки OpenCode (OPENCODE-3) — ключ `experimental.hook` того же opencode.json:
  // два события (`file_edited` — карта «шаблон файлов → действия»,
  // `session_completed` — массив действий), действие = argv-МАССИВ `command` +
  // необязательные `environment`.
  //
  // РАЗДЕЛ ТОЛЬКО ДЛЯ ЧТЕНИЯ с 2026-07-25. Сверка форматов (IDEA-3) поймала, а
  // проверка по документации подтвердила: ключа `experimental.hook` больше нет ни
  // в справочнике конфигурации OpenCode, ни в опубликованной схеме
  // `https://opencode.ai/config.json`, причём у `experimental` там
  // `additionalProperties: false` — то есть схема такой ключ ОТВЕРГАЕТ.
  // Задокументированный способ повесить действие на событие теперь один —
  // ПЛАГИНЫ (`plugin` + каталог `plugins/`), и он у панели уже есть отдельным
  // разделом. Писать ключ, которого нет ни в документации, ни в схеме, — гадание
  // о чужом формате, а оно запрещено. Читать продолжаем: у человека такой ключ
  // мог остаться от прежних версий, и прятать его было бы хуже.
  // Опишут ключ обратно → снять `writeDisabledReason`, адаптер трогать не нужно.
  hooksConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
    writeDisabledReason:
      'Ключ experimental.hook исчез из справочника конфигурации OpenCode и из опубликованной схемы (проверено 25 июля 2026), а `experimental` в схеме закрыт для чужих ключей. Панель больше не пишет его: задокументированный способ повесить действие на событие — плагины.',
  },
  // Плагины OpenCode (OPENCODE-4) — два задокументированных способа сразу:
  // КАТАЛОГ файлов JS/TS `~/.config/opencode/plugins/`, которые CLI подхватывает
  // при старте, и массив имён npm-пакетов `plugin` в opencode.json (ключ
  // подтверждён и страницей плагинов, и опубликованной схемой конфигурации).
  // Каталог ведётся файловым менеджером с той же защитой путей, что у правил
  // Cursor; список npm правится с сохранением всех прочих ключей файла.
  pluginsConfig: {
    format: 'opencode-plugins',
    dir: () => join(opencodeConfigDir(), 'plugins'),
    configPath: opencodeConfigFile,
  },
  // Скиллы OpenCode (OPENCODE-5) — каталог `~/.config/opencode/skills/`, папка на
  // скилл, внутри `SKILL.md` с YAML-шапкой. Понятие то же, что у Claude, но поля
  // шапки свои: распознаются `name` (обязательное), `description` (обязательное),
  // `license`, `compatibility`, `metadata`; всё прочее CLI игнорирует, а панель
  // сохраняет. Путь каталога НЕ следует за `OPENCODE_CONFIG` — та переменная
  // переносит только сам файл конфигурации.
  // Каталоги `~/.claude/skills` и `~/.agents/skills` OpenCode тоже читает,
  // поэтому уже готовые скиллы Claude в нём работают без переноса. Панель
  // сообщает об этом и НИЧЕГО туда не пишет: ими ведает раздел скиллов Claude.
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(opencodeConfigDir(), 'skills'),
    alsoLoadedFrom: () => [
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.agents', 'skills'),
    ],
  },
  // Переменных окружения у OpenCode НЕТ (OPENCODE-2, `env = unsupported`): по
  // документации он умеет только подстановку `{env:ПЕРЕМЕННАЯ}` внутри
  // opencode.json, то есть ЧИТАЕТ уже заданное окружение процесса, и своего
  // `.env` не загружает (это открытая просьба к разработчикам, а не готовая
  // возможность). Файл, который никто не читает, панель создавать не станет →
  // `envConfig` не задан, раздел скрыт.
  // Проектный уровень OpenCode (COMMON-2 + OPENCODE-1): задокументированы
  // проектный AGENTS.md и `<проект>/opencode.json` — тот же формат
  // `opencode-json`, поэтому оба адаптера (MCP и права) переиспользуются целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'opencode-json', relativePath: 'opencode.json' },
    permissions: { format: 'opencode-json', relativePath: 'opencode.json' },
    // Хуки проекта (OPENCODE-3): тот же ключ `experimental.hook` того же формата
    // в проектном opencode.json — адаптер переиспользуется целиком.
    hooks: { format: 'opencode-json', relativePath: 'opencode.json' },
    // Плагины проекта (OPENCODE-4): задокументированный каталог
    // `<проект>/.opencode/plugins/` плюс массив `plugin` в проектном конфиге.
    plugins: {
      format: 'opencode-plugins',
      relativeDir: '.opencode/plugins',
      relativePath: 'opencode.json',
    },
    // Скиллы проекта (OPENCODE-5): задокументированный каталог
    // `<проект>/.opencode/skills/` — тот же формат, адаптер переиспользуется.
    skills: { format: 'skill-md-dir', relativeDir: '.opencode/skills' },
  },
  // Детект «конфиг найден» (Ф7): задокументированы оба варианта размещения —
  // XDG-каталог ~/.config/opencode и ~/.opencode. Достаточно любого из них.
  // NB: пишем ВСЕГДА в канонический XDG-путь (см. instructionsFile/mcpConfig) —
  // выбирать файл по факту существования значило бы угадывать, куда смотрит CLI.
  // Плюс сам файл конфигурации, ЕСЛИ он перенесён `OPENCODE_CONFIG`: каталога
  // `~/.config/opencode` у такого пользователя может не быть вовсе.
  configLocations: () => {
    const locations = [opencodeConfigDir(), join(homedir(), '.opencode')];
    const file = opencodeConfigFile();
    if (dirname(file) !== opencodeConfigDir()) locations.push(file);
    return locations;
  },
  // Ассистент OpenCode: OpenAI-совместимый API (ключ настраивается на стороне
  // самого OpenCode, стандартной единой env-переменной нет → apiKeyEnvVars пуст),
  // есть рабочий CLI (`opencode`) → раннер `cli`, пока ключ не задан в панели.
  // OPENCODE-7: задокументированный one-shot — подкоманда `run`, промпт идёт
  // ПОЗИЦИОННЫМ аргументом в конце (`opencode run "<текст>"`); стандартный ввод
  // CLI не поддерживает, поэтому передать промпт можно только так. Промпт —
  // ОТДЕЛЬНЫЙ элемент argv, никакой сборки строки для оболочки.
  // IDEA-8: у OpenCode есть и ЗАДОКУМЕНТИРОВАННЫЙ локальный сервер
  // (`opencode serve --port <n> --hostname <адрес>`) с сессиями — диалог держит
  // сам CLI, панель шлёт только новое сообщение. Панель пробует его ПЕРВЫМ и при
  // любой заминке молча возвращается к one-shot (см. domains/opencode-serve.ts).
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: [],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['run', prompt],
    sessionServer: 'opencode',
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // OPENCODE-1: права — ключ `permission` в opencode.json (глобальном и проектном).
    permissions: 'ready',
    // OPENCODE-2: у OpenCode НЕТ места для переменных окружения — только
    // подстановка `{env:ПЕРЕМЕННАЯ}` из уже заданного окружения процесса.
    // Значит раздел не «в разработке», а неприменим → скрыт (unsupported).
    env: 'unsupported',
    // OPENCODE-7: one-shot задокументирован — `opencode run "<промпт>"`. Basic-чат
    // работает через тот же раннер, что у codex/gemini/aider, и остаётся с
    // пометкой «экспериментально»: `opencode` на этой машине не установлен.
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // OPENCODE-5: скиллы — каталог `skills/` (глобальный и проектный), папка на
    // скилл со `SKILL.md`. Понятие то же, что у Claude; поля шапки и правила
    // имени — свои, задокументированные.
    skills: 'ready',
    // OPENCODE-3: хуки — ключ `experimental.hook` в opencode.json (глобальном и
    // проектном). Модель СВОЯ, не claude-овская: два события и argv-действия.
    // Раздел честно помечен «экспериментально у самого OpenCode» — ключ лежит
    // под `experimental`, который OpenCode объявляет нестабильным.
    hooks: 'ready',
    // OPENCODE-4: плагины — каталог файлов JS/TS (`plugins/`, глобальный и
    // проектный) плюс массив npm-пакетов `plugin` в opencode.json.
    plugins: 'ready',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: собственный шлюз OpenCode Zen (models.dev, вендор `opencode`).
  modelVendors: ['opencode'],
};

/** Глобальный конфиг Aider — задокументированный `~/.aider.conf.yml` в домашнем каталоге. */
export function aiderConfigFile(): string {
  return join(homedir(), '.aider.conf.yml');
}

/** Имя конфигурационного файла Aider — одинаково в домашнем каталоге и в корне репозитория. */
export const AIDER_CONFIG_BASENAME = '.aider.conf.yml';

/**
 * Aider: конфиг `.aider.conf.yml`.
 *
 * ЧТО ВКЛЮЧЕНО — только подтверждённое документацией:
 *  - **переменные окружения** (`env = ready`, Ф11a): задокументированный ключ
 *    `set-env` («Set an environment variable (to control API settings, can be
 *    used multiple times)», значение — строка `КЛЮЧ=значение` либо список таких
 *    строк, aider.chat/docs/config/options.html);
 *  - **инструкции** (`globalInstructions = ready`, AIDER-1) — В ДРУГОЙ МОДЕЛИ,
 *    чем у Claude: единого файла инструкций у Aider нет, файлы контекста
 *    подключаются опцией `read` — СПИСКОМ путей (`read: [CONVENTIONS.md,
 *    anotherfile.txt]`). Панель управляет этим СПИСКОМ ССЫЛОК (`instructionsList`,
 *    а не `instructionsFile`) и содержимым тех перечисленных файлов, которые
 *    реально существуют; файлов «от себя» не создаёт;
 *  - **проектный уровень** (`projects = ready`, AIDER-4): по документации конфиг
 *    ищется в домашнем каталоге, в КОРНЕ GIT-РЕПОЗИТОРИЯ и в текущем каталоге
 *    (загружается в этом порядке, поздний перекрывает ранний) → `<проект>/
 *    .aider.conf.yml` это задокументированный путь. Проектный уровень
 *    покрывает то же, что глобальный: список `read` + `set-env`;
 *  - **чат** (`chat = ready`, AIDER-2): задокументированный one-shot-флаг
 *    `--message <text>` — «Specify a single message to send the LLM, process
 *    reply then exit (disables chat mode)». Промпт передаётся ОТДЕЛЬНЫМ
 *    элементом argv, без shell-интерполяции. NB: `aider` на машине разработки не
 *    установлен — раннер собран по документации и НЕ проверен живым прогоном
 *    (verify-on-first-real-run), поэтому провайдер остаётся `experimental`.
 *
 * ЧТО ОСТАЁТСЯ ВЫКЛЮЧЕННЫМ: **MCP** — `unsupported`: в справочнике опций Aider
 * настройки MCP-серверов нет вовсе. Форматы не угадываем.
 *
 * Все правки конфига идут Document API пакета `yaml` (зависимость УЖЕ есть в
 * apps/server): комментарии, порядок ключей и незатронутые ключи целы, бэкап +
 * атомарная запись, round-trip-проверка до записи (см. `lib/aider-yaml.ts`).
 */
const aiderProvider: ConfigProvider = {
  id: 'aider',
  name: 'Aider',
  status: 'experimental',
  paths: unimplementedPaths('aider'),
  cli: { command: 'aider', windowsCommand: 'aider.cmd' },
  // Инструкции Aider — СПИСОК ССЫЛОК `read` в том же ~/.aider.conf.yml, а не
  // отдельный файл: `instructionsFile` у него не бывает (см. AIDER-1).
  instructionsList: { format: 'aider-yaml', path: aiderConfigFile },
  // Переменные окружения Aider — список `set-env` в ~/.aider.conf.yml. Запись
  // через Document API пакета `yaml`: правится ТОЛЬКО узел `set-env`, комментарии
  // и прочие ключи (model, api-key, read, …) остаются на месте.
  envConfig: { format: 'aider-yaml', path: aiderConfigFile },
  // Проектный уровень Aider (AIDER-4): конфиг в КОРНЕ репозитория — тот же файл
  // того же формата, поэтому оба адаптера переиспользуются целиком, меняется
  // только путь (и он перепроверяется `isInsideProject`).
  projectConfig: {
    instructionsList: { format: 'aider-yaml', relativePath: AIDER_CONFIG_BASENAME },
    env: { format: 'aider-yaml', relativePath: AIDER_CONFIG_BASENAME },
  },
  // Детект «конфиг найден» (Ф7): у Aider каталога конфигурации нет — есть
  // задокументированные файлы в домашнем каталоге. Проверяем только их наличие.
  configLocations: () => [aiderConfigFile(), join(homedir(), '.aider.model.settings.yml')],
  // Ассистент Aider: OpenAI-совместимый (работает с разными моделями), ключ —
  // OPENAI_API_KEY или ANTHROPIC_API_KEY; есть рабочий CLI (`aider`).
  // One-shot: `aider --message <prompt>` — отправляет одно сообщение, печатает
  // ответ и выходит (интерактивный чат при этом отключается).
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['--message', prompt],
  },
  capabilities: buildCapabilities({
    // AIDER-1: инструкции есть, но модель другая — список ссылок `read`.
    globalInstructions: 'ready',
    env: 'ready',
    // AIDER-2: one-shot `--message` задокументирован. Живым прогоном не проверен
    // (CLI не установлен) → бейдж «экспериментально» в интерфейсе остаётся.
    chat: 'ready',
    // AIDER-4: `<проект>/.aider.conf.yml` — задокументированный путь.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
  }),
};

/**
 * Экспериментальные провайдеры в порядке отображения. Claude в этот список не
 * входит — он подмешивается реестром первым как проверенный провайдер-дефолт.
 */
export const CATALOG_PROVIDERS: ConfigProvider[] = [
  codexProvider,
  geminiProvider,
  qwenProvider,
  continueProvider,
  gooseProvider,
  kimiProvider,
  cursorProvider,
  opencodeProvider,
  aiderProvider,
];
