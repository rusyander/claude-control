import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types/types.ts';
import { unimplementedPaths } from './config-dirs.ts';
import { geminiContourBypass } from './gemini-contour.ts';
import { createGeminiStreamParser } from './gemini-stream.ts';

/** Каталог конфигурации Gemini: переопределения документация не заявляет. */
const geminiHome = (): string => join(homedir(), '.gemini');

/** MCP и права Gemini лежат в одном `settings.json`, каждый — своими ключами. */
const geminiSettings = (): string => join(geminiHome(), 'settings.json');

/** Gemini CLI: GEMINI.md + ~/.gemini/settings.json. */
/** Инструменты канона под именами Gemini 0.63 — из списка, который он шлёт модели. */
const GEMINI_TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: 'run_shell_command',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  Glob: 'glob',
  Grep: 'grep_search',
  LS: 'list_directory',
  WebFetch: 'web_fetch',
  WebSearch: 'google_web_search',
};

export const geminiProvider: ConfigProvider = {
  id: 'gemini',
  name: 'Gemini CLI',
  status: 'experimental',
  paths: unimplementedPaths('gemini'),
  cli: { command: 'gemini', windowsCommand: 'gemini.cmd' },
  // Глобальный файл инструкций Gemini задокументирован (~/.gemini/GEMINI.md).
  instructionsFile: () => join(geminiHome(), 'GEMINI.md'),
  // MCP-серверы Gemini — объект mcpServers в ~/.gemini/settings.json. Запись:
  // JSON.parse → правим только ключ mcpServers → JSON.stringify (прочее цело).
  mcpConfig: { format: 'json', path: geminiSettings },
  // Переменные окружения Gemini (GEMINI-3) — задокументированный файл `.env`:
  // глобальный `~/.gemini/.env`, проектный `<проект>/.gemini/.env`. Правка
  // ПОСТРОЧНАЯ: меняются только строки затронутых ключей, комментарии/пустые
  // строки/порядок целы, новые ключи дописываются в конец (см. lib/dotenv-file.ts).
  envConfig: { format: 'dotenv', path: () => join(geminiHome(), '.env') },
  // Права/аппрувы Gemini (GEMINI-2) — в том же settings.json: режим аппрувов
  // `general.defaultApprovalMode` (default | auto_edit | plan) и списки
  // инструментов `tools.core` (белый) / `tools.exclude` (чёрный, приоритетнее).
  // Значение `yolo` панель НЕ пишет никогда: по докам это режим только для флага
  // CLI, а в settings.json он валит старт ошибкой enum (сервер отвечает 400).
  permissionsConfig: {
    format: 'gemini-json',
    path: geminiSettings,
    // Правила поимённо: белый список `tools.core` и чёрный `tools.exclude`.
    // Третьего списка (спросить) у Gemini нет — правило `ask` понижается до
    // `deny`, и матрица верности обязана назвать это понижением.
    model: 'rules',
    decisions: ['allow', 'deny'],
    // Перенос правил канона — по живой пробе 10.10.2026 (gemini 0.63.0):
    // - имена инструментов свои, и правило `Read(...)` дословно не значит для
    //   Gemini ничего — запрет писался и не действовал;
    // - уточнение аргумента в `tools.exclude` не держит: и `read_file(файл)`, и
    //   `run_shell_command(node)` под `-y` исполнились, запрет целого
    //   инструмента — закрыл. Правило с аргументом — отказ, а не запрет всего;
    // - `allow` канона — «не спрашивать», а `tools.core` — «ТОЛЬКО эти
    //   инструменты»: перенесённое разрешение одного чтения отняло бы у Gemini
    //   все остальные. Поэтому переносится лишь запрет.
    ruleGrammar: {
      tools: GEMINI_TOOL_NAMES,
      closed: true,
      argumentTools: [],
      argumentSyntax: 'own',
      oneShapePerTool: false,
      toolDecisions: Object.fromEntries(
        Object.values(GEMINI_TOOL_NAMES).map((tool) => [tool, ['deny'] as const]),
      ),
    },
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
  // Слэш-команды Gemini — задокументированный каталог `~/.gemini/commands` с
  // файлами `.toml` (обязателен `prompt`, `description` необязателен), подкаталог
  // даёт пространство имён: `git/fix.toml` вызывается как `/git:fix`. Только чтение.
  commandsConfig: {
    format: 'toml-prompt',
    dir: () => join(geminiHome(), 'commands'),
    namespaceSeparator: ':',
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.gemini. Только проверка существования.
  configLocations: () => [geminiHome()],
  // Рычаги экономии групп (план экономии чужих CLI, 22.10.2026). Канала нет: оба родных
  // ключа живут только в файлах настроек, а файл на прогон CLI не берёт — почему,
  // см. `economy-run/gemini.ts` (живая проба gemini 0.65.0).
  groupEconomy: {
    support: {
      // `model.compressionThreshold` и `tools.truncateToolOutputThreshold` — только в
      // настройках; системный файл на прогон CLI пропускает, если он не администратора.
      compactWindow: { support: 'disproportionate', note: 'economy-note-admin-settings' },
      bashOutputChars: { support: 'disproportionate', note: 'economy-note-admin-settings' },
      // `read_file` режет сам: 2000 строк по 2000 знаков, ключа нет.
      readOutputTokens: { support: 'impossible', note: 'economy-note-hardcoded-limit' },
      // Кэш Gemini неявный: срок не задаётся.
      cacheTtl: { support: 'impossible', note: 'economy-note-cache-implicit' },
      // `gemini -p` без редактора.
      detachIde: { support: 'meaningless', note: 'economy-note-no-ide' },
      // Доставка — на младшей модели лестницы (`modelLadder` ниже, `cheap-deliver.ts`).
      sonnetDeliver: { support: 'emulated' },
      // Каждый ответ — свой запуск с короткой историей: держать между ходами нечего.
      freshOnColdResume: { support: 'meaningless', note: 'economy-note-one-shot' },
      keepWarm: { support: 'meaningless', note: 'economy-note-one-shot' },
      // Строка привычек — нейтральная часть той же строки, что у Claude.
      workHabits: { support: 'emulated' },
    },
  },
  // Ассистент Gemini: API — Google (ключи GEMINI_API_KEY / GOOGLE_API_KEY), есть
  // рабочий CLI (`gemini`). Обе стандартные переменные подхватываются автоматически.
  // One-shot: `gemini -p <prompt>` — неинтерактивный print-режим (флаг задокументирован).
  assistant: {
    apiKind: 'google',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    cliRunnable: true,
    // Подбор модели (Т12): `-m/--model` задокументирован («Specify the model»)
    // и работает вместе с `-p`. Аналога глубины у Gemini CLI нет — `run.effort`
    // здесь не участвует вовсе, и придумывать ему флаг нельзя.
    // «Разрешить правки» (`gemini --help` 0.62.0: `--approval-mode
    // default|auto_edit|yolo|plan`). Включено — `yolo`, как у qwen и живого хода:
    // каждая просьба получает «да». Выключено — `default`: в `-p` спросить
    // некого, и CLI не объявляет модели инструменты записи вовсе (живьём:
    // `write_file` → «Tool not found», файл цел), даже если в настройках стоит
    // `auto_edit`. Без политики (ассистент формы, разбор групп) флага нет —
    // решают настройки CLI. Вывод — `-o stream-json`: на win32 после хода с
    // инструментом gemini 0.62.0 печатает ответ и падает на выходе (0xC0000409),
    // и только событие `result: success` в потоке отличает такой ответ от сбоя
    // (см. gemini-stream.ts).
    oneShotArgs: (prompt, run) => [
      ...(run?.model ? ['-m', run.model] : []),
      ...(run?.allowEdits === undefined
        ? []
        : ['--approval-mode', run.allowEdits ? 'yolo' : 'default']),
      '-o',
      'stream-json',
      '-p',
      prompt,
    ],
    parseStdout: createGeminiStreamParser,
    // Переключатель правок доходит флагом `--approval-mode` (см. `oneShotArgs`).
    editsControl: 'flag',
  },
  // Свой эндпоинт: задокументированная переменная `GOOGLE_GEMINI_BASE_URL`
  // («Overrides the default base URL for Gemini API requests») — она же
  // требует HTTPS везде, кроме localhost/127.0.0.1/[::1]. Модель —
  // `GEMINI_MODEL`, ключ — `GEMINI_API_KEY`; всё это документация прямо
  // разрешает держать в `.env`, куда панель и пишет. Vertex-адрес
  // (`GOOGLE_VERTEX_BASE_URL`) — другой вид авторизации, сюда не тянем.
  endpointConfig: {
    google: {
      baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL',
      modelEnv: 'GEMINI_MODEL',
      credentialEnv: 'GEMINI_API_KEY',
      // Адрес читается только при входе ключом API (`gemini-contour.ts`).
      bypass: () => geminiContourBypass(geminiSettings()),
    },
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // GEMINI-2: права — `general.defaultApprovalMode` + tools.core/tools.exclude.
    permissions: 'ready',
    // GEMINI-3: переменные окружения — файл `.env` (глобальный и проектный).
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Команды: каталог `commands/*.toml` задокументирован — раздел читает его.
    commands: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Google (models.dev).
  modelVendors: ['google'],
  // Лестница подбора (Т12): `flash-lite` и `flash` — младшие линейки Gemini, обе
  // ниже линейки `pro`, которой CLI работает по умолчанию. Семейства однородны:
  // в каждом только своя ступень, поэтому «свежайшая в семействе» не меняет
  // класс модели. `gemini-pro` в лестницу не берём — верх у чужого CLI это его
  // собственная настройка, и панель её не подменяет.
  modelLadder: ['gemini-flash-lite', 'gemini-flash'],
};
