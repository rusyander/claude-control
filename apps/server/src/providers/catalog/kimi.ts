import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIMI_BLOCKING_EVENTS, KIMI_HOOK_EVENTS } from '../../lib/kimi-hook.ts';
import { kimiTranscriptParser } from '../../lib/kimi-transcript.ts';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { kimiCodeHome, unimplementedPaths } from './config-dirs.ts';
import { contourModelName, readConfigRoot } from './run-endpoint.ts';

/**
 * Профиль главного агента «только чтение» для `kimi -p` при выключенных правках.
 * Лежит рядом с каталогом и в конфиг человека не пишется: `--agent-file`
 * действует на один запуск. Тело — `${base_prompt}`, так что системный промпт
 * Kimi (с AGENTS.md, скиллами и плагинами) остаётся прежним.
 */
export const KIMI_READ_ONLY_AGENT = fileURLToPath(
  new URL('./kimi-read-only-agent.md', import.meta.url),
);

/** Один `config.toml` держит и права (`[permission]`), и хуки (`[[hooks]]`). */
const kimiConfigToml = (): string => join(kimiCodeHome(), 'config.toml');

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
export const kimiProvider: ConfigProvider = {
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
  permissionsConfig: {
    format: 'kimi-toml',
    path: kimiConfigToml,
    // Массив таблиц `[[permission.rules]]`: `decision` из набора + `pattern`.
    model: 'rules',
    decisions: ['allow', 'ask', 'deny'],
  },
  // Хуки Kimi (KIMI-1) — массив таблиц `[[hooks]]` в том же config.toml:
  // событие + матчер + команда оболочки + таймаут В СЕКУНДАХ (1–600).
  hooksConfig: {
    format: 'kimi-toml',
    path: kimiConfigToml,
    // Имена событий — из самого адаптера формата: вторая копия списка разошлась
    // бы с ним молча.
    events: [...KIMI_HOOK_EVENTS],
    // Блокировать умеют ровно три события из четырнадцати — это сказано в
    // документации прямо (`lib/kimi-hook.ts`, KIMI_BLOCKING_EVENTS).
    blockingEvents: [...KIMI_BLOCKING_EVENTS],
  },
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
    writeDisabledReason:
      'Состоянием плагинов Kimi владеет его собственная команда `/plugins`, а форма реестра `installed.json` не задокументирована. Плагин как единица сюда не переносится; его содержимое — скиллы, команды, хуки, субагенты — едет обычными записями канона.',
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
  // Ассистент: модельное API Kimi — OpenAI-совместимое API Moonshot, ключ в
  // `KIMI_API_KEY`/`MOONSHOT_API_KEY`. One-shot: `kimi -p <промпт>`. Живой ход
  // (сообщение посреди ответа) — через `kimi web`: занятая сессия ставит
  // сообщение в очередь, `prompts:steer` вливает его в идущий ход
  // (`domains/provider-chat/live/kimi-server.ts`).
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    // Адрес — из документации самого вендора (D1): Moonshot API reference
    // (https://platform.moonshot.ai/docs/api/chat) зовёт
    // `https://api.moonshot.ai/v1/chat/completions` ключом `MOONSHOT_API_KEY`, а
    // Kimi Code для ключа `KIMI_API_KEY` называет тот же `https://api.moonshot.ai/v1`
    // (Environment variables: `KIMI_BASE_URL`). `api.kimi.com/coding/v1` — адрес
    // подписки после `/login` (OAuth), не ключа: туда ключ не идёт.
    apiBaseUrl: 'https://api.moonshot.ai/v1',
    cliRunnable: true,
    // «Разрешить правки» в одиночном запуске (D2). `-p` не сочетается ни с
    // `--plan`, ни с `-y`, ни с `--auto` (CLI отказывает при старте) и всегда
    // идёт под политикой `auto`: просьба записать файл исполняется без вопроса,
    // даже при `default_permission_mode = "manual"` (живая проба 2.1.1 и
    // документация `kimi` Command). Поэтому выключено — профиль агента
    // `--agent-file` с одними читающими инструментами: Write/Edit/Bash модель не
    // видит, а вызов мимо списка CLI отклоняет сам («Tool "Write" not found»).
    // Включено или переключателя нет — argv прежний: это и есть «правки можно».
    oneShotArgs: (prompt, run) => [
      ...(run?.allowEdits === false ? ['--agent-file', KIMI_READ_ONLY_AGENT] : []),
      '-p',
      prompt,
    ],
    // Оформление стенограммы `kimi -p` (`• ` и отступ) из ответа убирается.
    parseStdout: kimiTranscriptParser,
    liveServer: 'kimi-server',
    // Переключатель доходит профилем `--agent-file` (см. `oneShotArgs`) и
    // ответом живого сервера на просьбу о разрешении.
    editsControl: 'flag',
  },
  // Контур (X7): модель целиком из окружения — `KIMI_MODEL_*` (документация
  // «Environment variables» Kimi Code). CLI заводит из них модель
  // `__kimi_env_model__`, и она перебивает `default_model` конфига; запрос идёт
  // на `<адрес>/chat/completions` с ключом из окружения (живая проба 2.1.1).
  // `KIMI_BASE_URL`/`KIMI_API_KEY` — поля конфига, не переменные: не годятся.
  runEndpoint: {
    apiKind: 'openai-compat',
    env: ({ baseUrl, model, key }) => ({
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: baseUrl,
      KIMI_MODEL_API_KEY: key,
      KIMI_MODEL_NAME: contourModelName(model),
    }),
    // Вторая модель (`[secondary_model]`) ходит своим провайдером, а переменной,
    // перебивающей её, документация не называет (`KIMI_SECONDARY_MODEL` в бинаре
    // есть, в документации — нет): прогон отказывает, а не уходит в облако.
    bypass: () => {
      const secondary = readConfigRoot(kimiConfigToml(), 'toml').secondary_model;
      const model =
        secondary && typeof secondary === 'object'
          ? (secondary as Record<string, unknown>).model
          : undefined;
      return typeof model === 'string' && model.trim() ? '[secondary_model] model' : undefined;
    },
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
  // Подбора модели (Т12) у Kimi НЕТ: его `-m` принимает не имя модели из
  // каталога, а ИМЯ ЗАПИСИ из личной таблицы `models` в конфиге пользователя.
  // Что там названо и на что ссылается, панель не знает — подставлять туда
  // `kimi-k2.7-code` значит выдумывать формат.
};
