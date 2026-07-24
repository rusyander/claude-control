import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
 *    заданным `XDG_CONFIG_HOME` путь `~/.config/opencode` попросту неверен.
 *
 * У Gemini, Cursor и Aider задокументированного переопределения каталога нет →
 * ничего не выдумываем, пути остаются от `os.homedir()`.
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

/** Каталог конфигурации OpenCode: `$XDG_CONFIG_HOME/opencode`, иначе `~/.config/opencode`. */
export function opencodeConfigDir(): string {
  return join(envDir('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'opencode');
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
  // Проектный уровень Cursor (COMMON-2 + CURSOR-1): задокументированы проектный
  // MCP `<проект>/.cursor/mcp.json` (та же форма, адрес удалённого сервера в
  // `url`) и проектный КАТАЛОГ ПРАВИЛ `<проект>/.cursor/rules/*.mdc` — тот же
  // формат `.mdc`, что и у глобального каталога, поэтому адаптер переиспользуется
  // целиком, меняется только корень (и он перепроверяется `isInsideProject`).
  projectConfig: {
    instructionsRules: { format: 'cursor-mdc', relativeDir: '.cursor/rules' },
    mcp: { format: 'json', relativePath: '.cursor/mcp.json', jsonHttpUrlKey: 'url' },
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
    // Проектный уровень (COMMON-2 + CURSOR-1): проектный MCP `.cursor/mcp.json`
    // тем же json-адаптером и проектный каталог правил `.cursor/rules/*.mdc` тем
    // же адаптером `.mdc`, что и глобальный.
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
    path: () => join(opencodeConfigDir(), 'opencode.json'),
  },
  // Проектный уровень OpenCode (COMMON-2): задокументированы проектный AGENTS.md
  // и `<проект>/opencode.json` (тот же формат `opencode-json`, что и глобальный).
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'opencode-json', relativePath: 'opencode.json' },
  },
  // Детект «конфиг найден» (Ф7): задокументированы оба варианта размещения —
  // XDG-каталог ~/.config/opencode и ~/.opencode. Достаточно любого из них.
  // NB: пишем ВСЕГДА в канонический XDG-путь (см. instructionsFile/mcpConfig) —
  // выбирать файл по факту существования значило бы угадывать, куда смотрит CLI.
  configLocations: () => [opencodeConfigDir(), join(homedir(), '.opencode')],
  // Ассистент OpenCode: OpenAI-совместимый API (ключ настраивается на стороне
  // самого OpenCode, стандартной единой env-переменной нет → apiKeyEnvVars пуст),
  // есть рабочий CLI (`opencode`) → раннер `cli`, пока ключ не задан в панели.
  assistant: { apiKind: 'openai-compat', apiKeyEnvVars: [], cliRunnable: true },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'planned',
    env: 'planned',
    // Чат остаётся planned: у OpenCode нет задокументированного one-shot-флага
    // CLI и стандартной env-переменной ключа → надёжного basic-раннера пока нет.
    chat: 'planned',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    skills: 'planned',
    hooks: 'planned',
    plugins: 'planned',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
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
  cursorProvider,
  opencodeProvider,
  aiderProvider,
];
