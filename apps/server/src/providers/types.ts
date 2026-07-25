import type { ClaudePaths } from '@claude-control/contracts';

/**
 * Провайдер конфигурации на стороне сервера (мульти-провайдерность).
 *
 * Логика Claude — адаптер #1, поведение не меняется. Провайдер инкапсулирует
 * четыре вещи, различающиеся между CLI: где лежат файлы (`paths`), чем
 * запускается инструмент (`cli`), насколько он проверен (`status`) и что из
 * разделов панели он поддерживает (`capabilities` — карта статусов).
 *
 * Почему union возможностей и статусов продублирован здесь значением, а не взят
 * из `@claude-control/contracts`: contracts тянется в сервер ТОЛЬКО как тип. Его
 * barrel реэкспортирует модули без расширений, а Node ESM в рантайме такие пути
 * не резолвит — импорт ЗНАЧЕНИЯ из contracts уронил бы сервер на старте
 * (`ERR_MODULE_NOT_FOUND`). Список обязан совпадать с contracts `CAPABILITIES`.
 */
export const CAPABILITIES = [
  'rules',
  'globalInstructions',
  'skills',
  'hooks',
  'scripts',
  'mcp',
  'permissions',
  'env',
  'plugins',
  'analytics',
  'projects',
  'chat',
  'sandbox',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Статус возможности у провайдера. `ready` — работает сейчас; `planned` —
 * поддержим, адаптера ещё нет (раздел «в разработке», ничего не пишет);
 * `unsupported` — у этого CLI такого нет (раздел скрыт). См. contracts.
 */
export type CapabilityStatus = 'ready' | 'planned' | 'unsupported';

/** Насколько провайдер проверен: `verified` (Claude) или `experimental`. */
export type ProviderStatus = 'verified' | 'experimental';

/** Полная карта возможностей: статус по каждому ключу. */
export type CapabilityMap = Record<Capability, CapabilityStatus>;

/**
 * Собрать карту возможностей из частичного набора. Не перечисленные ключи
 * получают `unsupported` — fail-closed по умолчанию: незаявленную возможность
 * панель не показывает и не трогает.
 */
export function buildCapabilities(overrides: Partial<CapabilityMap>): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const capability of CAPABILITIES) {
    map[capability] = overrides[capability] ?? 'unsupported';
  }
  return map;
}

/** Карта, где все возможности имеют один и тот же статус (для Claude — все `ready`). */
export function uniformCapabilities(status: CapabilityStatus): CapabilityMap {
  const map = {} as CapabilityMap;
  for (const capability of CAPABILITIES) map[capability] = status;
  return map;
}

/** Имена исполняемого файла CLI: обычное и windows-обёртка (`.cmd`). */
export interface ProviderCli {
  command: string;
  windowsCommand: string;
}

/**
 * Тип модельного API провайдера — какой ключ и какого рода ему нужен, чтобы
 * ассистент панели ходил в модель напрямую (режим `api`). `none` — у провайдера
 * нет собственного модельного API (Cursor): прямой вызов невозможен.
 */
export type AssistantApiKind = 'anthropic' | 'openai' | 'google' | 'openai-compat' | 'none';

/**
 * Метаданные ассистента провайдера (мульти-модельность, Ф6a).
 *
 * Гибрид выбора раннера: есть API-ключ (сохранён в панели или в стандартной
 * env-переменной) → режим `api`; ключа нет, но CLI провайдера установлен →
 * режим `cli`; иначе → `none` (панель просит ключ). Реальных вызовов моделей на
 * этой фазе НЕТ — только резолвинг раннера и хранение ключей.
 *
 * - `apiKind` — тип модельного API (по нему панель понимает, ключ какого рода
 *   нужен); `none` означает, что прямого модельного API у CLI нет.
 * - `apiKeyEnvVars` — стандартные переменные окружения, из которых ключ
 *   подхватывается автоматически. ТОЛЬКО заявленные имена — форматы чужих
 *   конфигов не угадываем.
 * - `cliRunnable` — можно ли запустить ассистента через CLI провайдера (когда
 *   ключа нет, но бинарь найден в PATH). У Cursor — false (ассистент unsupported).
 * - `oneShotArgs` — argv для НЕинтерактивного one-shot запуска CLI (Ф6b): промпт
 *   передаётся ОТДЕЛЬНЫМ элементом массива (без интерполяции в shell). Задаётся
 *   ТОЛЬКО там, где print-флаг задокументирован (gemini `-p`, codex `exec`); у
 *   остальных не задан → программный запуск через CLI невозможен (падаем в
 *   api/none). Claude сюда НЕ входит — он делегирует своему существующему пути.
 */
export interface ProviderAssistant {
  apiKind: AssistantApiKind;
  apiKeyEnvVars: string[];
  cliRunnable: boolean;
  oneShotArgs?: (prompt: string) => string[];
  /**
   * ПРОТОКОЛ локального сервера CLI, дающего СЕССИОННЫЙ (богатый) режим ассистента
   * вместо one-shot: диалог держит сам CLI, панель шлёт только новое сообщение.
   *
   * Значение называет протокол, а не просто «умеет сервер»: реализация под него
   * лежит в отдельном домене (`domains/opencode-serve.ts`). Не задан → сессионного
   * режима у провайдера нет, и панель его не выдумывает (fail-closed). Сейчас
   * задокументирован ровно один — `opencode serve`.
   */
  sessionServer?: 'opencode';
}

/**
 * Расположение и формат файла MCP-серверов провайдера.
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером формата (Codex — TOML,
 * Gemini/Cursor — JSON `mcpServers`, OpenCode — JSON `mcp`) — у них же `mcp` =
 * `ready`. Claude MCP живёт в ~/.claude.json и обслуживается собственными
 * (богатыми) роутами, поэтому `mcpConfig` у него НЕ задан: универсальный раздел
 * его не трогает. Провайдер без `mcpConfig` → универсальный раздел MCP
 * fail-closed (сервер отвечает 4xx).
 *
 * `path` строится через `os.homedir()` + `path.join` (кроссплатформенно). Codex,
 * Gemini, Cursor и OpenCode используют глобальные файлы, поэтому `override`
 * игнорируют.
 */
export interface ProviderMcpConfigLocation {
  /**
   * Формат файла:
   * - `json` — объект `mcpServers` (Gemini `settings.json`, Cursor `mcp.json`);
   * - `toml` — таблицы `[mcp_servers.<name>]` (Codex `config.toml`);
   * - `opencode-json` — объект `mcp` с формой `{ type: 'local'|'remote' }`
   *   (OpenCode `opencode.json`);
   * - `continue-yaml` — СПИСОК `mcpServers`, имя записи лежит внутри неё полем
   *   `name` (Continue `config.yaml`); правится Document API пакета `yaml`.
   * - `goose-yaml` — ОТОБРАЖЕНИЕ `extensions` «имя → запись» (Goose
   *   `config.yaml`): тип задаёт `type`, внешние серверы — только `stdio` / `sse`
   *   / `streamable_http`, встроенные расширения (`builtin` и прочие) не
   *   показываются и не правятся.
   */
  format: 'json' | 'toml' | 'opencode-json' | 'continue-yaml' | 'goose-yaml';
  /** Абсолютный путь к файлу MCP-конфигурации. */
  path: (override?: string) => string;
  /**
   * Формат `json`: под каким ключом лежит адрес удалённого (http) сервера.
   * У Gemini приоритетный ключ — `httpUrl` (стримируемый HTTP), у Cursor —
   * `url`. Не задан → `httpUrl` (историческое поведение Gemini). ЧТЕНИЕ понимает
   * оба ключа у обоих; ключ влияет только на ЗАПИСЬ — форматы не угадываем.
   */
  jsonHttpUrlKey?: 'httpUrl' | 'url';
}

/**
 * Расположение и формат файла переменных окружения провайдера.
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером env (Codex — таблица
 * `[shell_environment_policy.set]` в config.toml; Aider — задокументированный
 * ключ `set-env` в `~/.aider.conf.yml`; Gemini — задокументированный файл
 * `~/.gemini/.env`) — у них же `env` = `ready`. У Claude переменные живут в
 * settings.json и обслуживаются собственными роутами `/api/env`, поэтому
 * `envConfig` у него НЕ задан. Провайдер без `envConfig` → универсальный раздел
 * env fail-closed (сервер отвечает 4xx).
 */
export interface ProviderEnvConfigLocation {
  /**
   * Формат файла:
   * - `toml` — таблица `[shell_environment_policy.set]` (Codex `config.toml`);
   * - `aider-yaml` — список `set-env` (Aider `~/.aider.conf.yml`), правится
   *   Document API пакета `yaml` с сохранением комментариев;
   * - `dotenv` — обычный `.env` (Gemini `~/.gemini/.env`), правится построчно с
   *   сохранением комментариев, пустых строк и порядка ключей.
   */
  format: 'toml' | 'aider-yaml' | 'dotenv';
  /** Абсолютный путь к файлу конфигурации с переменными окружения. */
  path: (override?: string) => string;
}

/**
 * Расположение конфигурации со СПИСКОМ ССЫЛОК на файлы инструкций (AIDER-1).
 *
 * Вторая модель раздела «Глобальные инструкции». У Claude/Codex/Gemini/OpenCode
 * это ОДИН файл (`instructionsFile`). У Aider единого файла нет: по документации
 * файлы контекста подключаются опцией `read` в `.aider.conf.yml` — СПИСКОМ путей.
 * Панель управляет этим списком (добавить/убрать/переставить) и, дополнительно,
 * содержимым тех перечисленных файлов, которые реально существуют.
 *
 * Задаётся ТОЛЬКО там, где формат подтверждён документацией; у провайдера с
 * `instructionsList` НЕ должно быть `instructionsFile` — модель одна из двух,
 * иначе раздел не знал бы, что показывать. Отсутствуют обе → раздел инструкций
 * fail-closed (сервер отвечает 4xx).
 */
export interface ProviderInstructionsListLocation {
  /** Формат конфигурации со списком: `aider-yaml` — ключ `read` в `.aider.conf.yml`. */
  format: 'aider-yaml';
  /** Абсолютный путь конфигурации, в которой лежит список ссылок. */
  path: (override?: string) => string;
}

/**
 * Расположение КАТАЛОГА ПРАВИЛ (CURSOR-1) — третья модель раздела «Глобальные
 * инструкции».
 *
 * У Claude/Codex/Gemini/OpenCode это ОДИН файл (`instructionsFile`), у Aider —
 * СПИСОК ССЫЛОК (`instructionsList`). У Cursor по документации ни то, ни другое:
 * правила лежат КАТАЛОГОМ файлов `.mdc` (глобальный `~/.cursor/rules/`,
 * проектный `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются), у
 * каждого файла свой YAML-frontmatter (`description` / `globs` / `alwaysApply`)
 * и markdown-тело.
 *
 * Задаётся ТОЛЬКО там, где формат подтверждён документацией. У провайдера должна
 * быть ровно ОДНА из трёх моделей — иначе раздел не знал бы, что показывать. Нет
 * ни одной → раздел инструкций fail-closed (сервер отвечает 4xx).
 */
export interface ProviderInstructionsRulesLocation {
  /**
   * Формат каталога: `cursor-mdc` — файлы `.mdc` с YAML-frontmatter (Cursor);
   * `continue-md` — файлы `.md` с тем же frontmatter (Continue,
   * `<проект>/.continue/rules`).
   */
  format: 'cursor-mdc' | 'continue-md';
  /** Абсолютный путь КАТАЛОГА правил (`~/.cursor/rules`). */
  dir: (override?: string) => string;
}

/**
 * Расположение и формат файла прав/аппрувов провайдера.
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером прав (Codex — скалярные
 * ключи корня `approval_policy` / `sandbox_mode` в config.toml; Gemini —
 * `general.defaultApprovalMode` + списки `coreTools`/`excludeTools` в
 * settings.json; OpenCode — ключ `permission` в opencode.json) — у них же
 * `permissions` = `ready`. У Claude права живут в settings.json (allow/deny/ask) и
 * обслуживаются собственными богатыми роутами, поэтому `permissionsConfig` у него
 * НЕ задан. Провайдер без `permissionsConfig` → универсальный раздел прав
 * fail-closed (сервер отвечает 4xx).
 */
export interface ProviderPermissionsConfigLocation {
  /**
   * Формат файла:
   * - `toml` — скалярные ключи корня (Codex `config.toml`);
   * - `gemini-json` — `general.defaultApprovalMode` + `coreTools`/`excludeTools`
   *   (Gemini `settings.json`), правятся точечно, прочие ключи сохраняются;
   * - `qwen-json` — `tools.approvalMode` + списки правил `permissions.allow` /
   *   `ask` / `deny` (Qwen Code `settings.json`). Форк Gemini, но ключи прав у
   *   него ДРУГИЕ — общий формат с `gemini-json` был бы записью не туда;
   * - `opencode-json` — ключ `permission` (OpenCode `opencode.json`): уровень
   *   `allow`/`deny`/`ask` у инструмента, у `bash` — ещё и карта шаблонов
   *   команд. Правится только `permission`, прочие ключи сохраняются;
   * - `continue-yaml` — ОТДЕЛЬНЫЙ файл `~/.continue/permissions.yaml` с тремя
   *   списками `allow` / `ask` / `exclude` и без режима-переключателя;
   * - `goose-yaml` — скалярный ключ КОРНЯ `GOOSE_MODE` (Goose `config.yaml`):
   *   `auto` / `approve` / `smart_approve` / `chat`, списков нет вовсе;
   * - `kimi-toml` — режим `default_permission_mode` + МАССИВ ТАБЛИЦ
   *   `[[permission.rules]]` (`decision` + `pattern`) в Kimi `config.toml`;
   * - `cursor-json` — ключ `permissions` с двумя списками `allow`/`deny`
   *   (Cursor `cli-config.json` глобально, `.cursor/cli.json` в проекте);
   *   режима нет, `deny` приоритетнее, прочие ключи файла сохраняются.
   */
  format:
    | 'toml'
    | 'gemini-json'
    | 'qwen-json'
    | 'opencode-json'
    | 'continue-yaml'
    | 'goose-yaml'
    | 'kimi-toml'
    | 'cursor-json';
  /** Абсолютный путь к файлу конфигурации с правами/аппрувами. */
  path: (override?: string) => string;
}

/**
 * Расположение и формат ХУКОВ провайдера (OPENCODE-3).
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером хуков — у них же
 * `hooks` = `ready`. У Claude хуки живут в settings.json событиями
 * `PreToolUse`/`PostToolUse` и обслуживаются собственными богатыми роутами
 * `/api/hooks`, поэтому `hooksConfig` у него НЕ задан: универсальный раздел его
 * не трогает (модель принципиально другая). Провайдер без `hooksConfig` →
 * универсальный раздел хуков fail-closed (сервер отвечает 4xx).
 */
export interface ProviderHooksConfigLocation {
  /**
   * Формат хранилища:
   * - `opencode-json` — ключ `experimental.hook` в `opencode.json`: два
   *   задокументированных события (`file_edited` — карта «шаблон → действия»,
   *   `session_completed` — массив действий), действие = argv-массив `command` +
   *   необязательные переменные `environment`. Правится только `experimental.hook`;
   *   прочие ключи `experimental` и незнакомые события сохраняются. С 25 июля
   *   2026 — только чтение (см. `writeDisabledReason` ниже);
   * - `qwen-json` — ключ КОРНЯ `hooks` в `settings.json` Qwen Code: событие →
   *   массив групп `{ matcher, hooks: [{ type: "command", command, timeout }] }`,
   *   таймаут в МИЛЛИСЕКУНДАХ. Панель ведёт группы ровно с одним действием типа
   *   `command`; событие любой другой формы сохраняется целиком и не правится;
   * - `kimi-toml` — МАССИВ ТАБЛИЦ `[[hooks]]` в `config.toml` Kimi Code: поля
   *   `event` / `matcher` / `command` / `timeout` (СЕКУНДЫ, 1–600). Плоский
   *   массив нельзя переписать частично, поэтому любое отклонение от формы
   *   переводит весь раздел в чтение.
   */
  format: 'opencode-json' | 'qwen-json' | 'kimi-toml';
  /** Абсолютный путь к файлу конфигурации с хуками. */
  path: (override?: string) => string;
  /**
   * Ключ ИСЧЕЗ из документации и опубликованной схемы CLI → раздел только для
   * чтения: панель по-прежнему показывает то, что уже лежит в файле, но писать
   * туда перестаёт. Текст — причина, её видит пользователь.
   *
   * Заведено ради `experimental.hook` у OpenCode (см. `catalog.ts`): писать
   * ключ, которого нет ни в справочнике, ни в схеме, — это гадание о чужом
   * формате, а оно запрещено. Опишут ключ обратно — поле убирается, и раздел
   * оживает без единой правки адаптера.
   */
  writeDisabledReason?: string;
}

/**
 * Расположение ПЛАГИНОВ провайдера (OPENCODE-4).
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером — у них же `plugins` =
 * `ready`. Раздел «Плагины» Claude — это расширения САМОЙ панели, у него своя
 * модель и свои роуты; `pluginsConfig` у Claude НЕ задан.
 *
 * У OpenCode способа два, и оба задокументированы: КАТАЛОГ файлов JS/TS,
 * загружаемых при старте, и МАССИВ `plugin` с именами npm-пакетов в конфиге.
 * Поэтому здесь два пути сразу.
 */
export interface ProviderPluginsConfigLocation {
  /**
   * Формат раздела:
   * - `opencode-plugins` — каталог файлов + массив `plugin` (правится);
   * - `kimi-plugins` — каталог `plugins/managed/<id>/` с JSON-манифестами
   *   (ТОЛЬКО ЧТЕНИЕ: форма реестра `installed.json` не задокументирована, а
   *   ставят и включают плагины командой `/plugins` внутри CLI).
   */
  format: 'opencode-plugins' | 'kimi-plugins';
  /** Абсолютный путь КАТАЛОГА плагинов (`~/.config/opencode/plugins`). */
  dir: (override?: string) => string;
  /** Абсолютный путь конфигурации с массивом `plugin` — только у OpenCode. */
  configPath?: (override?: string) => string;
  /** Абсолютный путь реестра установленного (`plugins/installed.json`) — Kimi. */
  registryPath?: (override?: string) => string;
}

/**
 * Расположение СКИЛЛОВ провайдера (OPENCODE-5).
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером — у них же `skills` =
 * `ready`. У Claude скиллы свои и богаче (включение переносом в
 * `skills-disabled/`, группы, вложенные файлы скилла) и живут на собственных
 * маршрутах `/api/skills`, поэтому `skillsConfig` у него НЕ задан. Провайдер без
 * `skillsConfig` → универсальный раздел скиллов fail-closed (сервер 4xx).
 */
export interface ProviderSkillsConfigLocation {
  /**
   * Формат каталога: `skill-md-dir` — папка на скилл, внутри `SKILL.md` с
   * YAML-шапкой (`name` и `description` обязательны).
   */
  format: 'skill-md-dir';
  /** Абсолютный путь КАТАЛОГА скиллов (`~/.config/opencode/skills`). */
  dir: (override?: string) => string;
  /**
   * Каталоги, из которых CLI грузит скиллы ПОМИМО собственного — только чтобы
   * сообщить об этом в интерфейсе. Панель туда НИЧЕГО не пишет: у OpenCode это
   * `~/.claude/skills` и `~/.agents/skills`, и скиллами Claude управляет
   * собственный раздел Claude.
   */
  alsoLoadedFrom?: () => string[];
  /**
   * Предел длины `description` В ЭТОМ CLI. Не задан → 1024 (OpenCode, Qwen: там
   * потолок не назван). У Kimi Code документация говорит прямо — «однострочная
   * сводка до 240 символов», и писать длиннее панель не станет.
   */
  descriptionMax?: number;
}

/**
 * Проектный уровень конфигурации провайдера (COMMON-2).
 *
 * Задаётся ТОЛЬКО у провайдеров, у которых проектные пути ЗАДОКУМЕНТИРОВАНЫ, — у
 * них же `projects` = `ready`. Пути ОТНОСИТЕЛЬНЫЕ (от корня проекта) и всегда
 * записываются через `/`: сервер разбивает их и собирает `path.join`, поэтому
 * они кроссплатформенны. Выйти за пределы проекта такой путь по построению не
 * может, и это дополнительно проверяется при резолве (`isInsideProject`).
 *
 * Claude сюда НЕ входит: его проектный уровень богаче (правила + права + хуки +
 * MCP) и живёт на собственных маршрутах `/api/projects/:id/{rules,mcp,permissions}`
 * — регресс-ноль, тот раздел не трогаем. Провайдер без `projectConfig` →
 * универсальный проектный раздел fail-closed (сервер отвечает 4xx).
 */
export interface ProviderProjectConfigLocation {
  /**
   * Относительный путь файла инструкций проекта (`AGENTS.md` у Codex/OpenCode,
   * `GEMINI.md` у Gemini). Не задан → раздела инструкций проекта нет (у Cursor
   * проектные правила — каталог `.cursor/rules/*.mdc`, это отдельная задача
   * CURSOR-1, формат не угадываем).
   */
  instructions?: string;
  /**
   * Проектная конфигурация со СПИСКОМ ССЫЛОК на файлы инструкций (AIDER-1) —
   * альтернатива `instructions` для провайдера, у которого инструкции устроены
   * списком, а не одним файлом. У Aider это `<проект>/.aider.conf.yml`: по
   * документации конфиг ищется в домашнем каталоге, в КОРНЕ GIT-РЕПОЗИТОРИЯ и в
   * текущем каталоге, поэтому файл в корне проекта — задокументированный путь.
   */
  instructionsList?: {
    format: ProviderInstructionsListLocation['format'];
    /** Относительный путь от корня проекта, разделитель — `/`. */
    relativePath: string;
  };
  /**
   * Проектный КАТАЛОГ ПРАВИЛ (CURSOR-1) — третья альтернатива `instructions`:
   * у Cursor правила проекта лежат в `<проект>/.cursor/rules/` файлами `.mdc`
   * (подкаталоги поддерживаются). Задокументировано ровно так же, как глобальный
   * каталог, поэтому домен и адаптер формата переиспользуются целиком.
   */
  instructionsRules?: {
    format: ProviderInstructionsRulesLocation['format'];
    /** Относительный путь КАТАЛОГА от корня проекта, разделитель — `/`. */
    relativeDir: string;
  };
  /**
   * Проектный файл MCP-серверов: относительный путь + формат (те же адаптеры,
   * что и у глобального раздела — `json` / `toml` / `opencode-json`).
   */
  mcp?: {
    format: ProviderMcpConfigLocation['format'];
    /** Относительный путь от корня проекта, разделитель — `/`. */
    relativePath: string;
    /** Ключ адреса http-сервера при записи (см. `ProviderMcpConfigLocation`). */
    jsonHttpUrlKey?: 'httpUrl' | 'url';
  };
  /**
   * Проектный файл переменных окружения: относительный путь + формат (тот же
   * адаптер, что и у глобального раздела). Задан только там, где проектный путь
   * ЗАДОКУМЕНТИРОВАН — у Gemini это `<проект>/.gemini/.env`.
   */
  env?: {
    format: ProviderEnvConfigLocation['format'];
    /** Относительный путь от корня проекта, разделитель — `/`. */
    relativePath: string;
  };
  /**
   * Проектный файл прав/аппрувов: относительный путь + формат (тот же адаптер,
   * что и у глобального раздела). Задан только там, где проектный путь
   * ЗАДОКУМЕНТИРОВАН — у Gemini это `<проект>/.gemini/settings.json`.
   */
  permissions?: {
    format: ProviderPermissionsConfigLocation['format'];
    /** Относительный путь от корня проекта, разделитель — `/`. */
    relativePath: string;
  };
  /**
   * Проектные ХУКИ (OPENCODE-3): тот же адаптер, что у глобального раздела.
   * У OpenCode это `<проект>/opencode.json` — задокументированный проектный
   * конфиг, а ключ `experimental.hook` в нём тот же самый.
   */
  hooks?: {
    format: ProviderHooksConfigLocation['format'];
    /** Относительный путь от корня проекта, разделитель — `/`. */
    relativePath: string;
  };
  /**
   * Проектные ПЛАГИНЫ (OPENCODE-4): каталог файлов + конфиг с массивом `plugin`.
   * У OpenCode это `<проект>/.opencode/plugins/` и `<проект>/opencode.json`.
   */
  plugins?: {
    // Проектных плагинов из всех провайдеров бывает только у OpenCode: у Kimi
    // плагины лежат в домашнем каталоге и проектного уровня не имеют.
    format: 'opencode-plugins';
    /** Относительный путь КАТАЛОГА файлов от корня проекта, разделитель — `/`. */
    relativeDir: string;
    /** Относительный путь конфига с массивом `plugin`, разделитель — `/`. */
    relativePath: string;
  };
  /**
   * Проектные СКИЛЛЫ (OPENCODE-5): каталог папок со `SKILL.md`. У OpenCode это
   * `<проект>/.opencode/skills/` — тот же формат, что и глобальный каталог,
   * поэтому домен и адаптер переиспользуются целиком.
   */
  skills?: {
    format: ProviderSkillsConfigLocation['format'];
    /** Относительный путь КАТАЛОГА от корня проекта, разделитель — `/`. */
    relativeDir: string;
  };
}

export interface ConfigProvider {
  /** Идентификатор провайдера — хранится в настройке `provider`. */
  id: string;
  /** Человекочитаемое имя для интерфейса. */
  name: string;
  /** Насколько провайдер проверен. */
  status: ProviderStatus;
  /**
   * Расположение файлов конфигурации — форма как у текущего `ClaudePaths`.
   * У провайдеров-данных (ещё без адаптера файлов) выбрасывает: на этой фазе
   * их файлы не читаются и не пишутся (fail-closed), путь спрашивать неоткуда.
   */
  paths: (override?: string) => ClaudePaths;
  /** Чем запускается CLI провайдера. */
  cli: ProviderCli;
  /** Карта статусов разделов панели у провайдера. */
  capabilities: CapabilityMap;
  /**
   * Абсолютный путь к глобальному файлу инструкций провайдера
   * (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).
   *
   * Задан ТОЛЬКО у провайдеров с задокументированным форматом файла (Claude,
   * Codex, Gemini) — у них же `globalInstructions` = `ready`. У остальных
   * отсутствует: раздел инструкций fail-closed (сервер отвечает 4xx), путь панель
   * НЕ угадывает. Аргумент `override` — пользовательский путь к каталогу
   * конфигурации: его уважает только Claude; Codex/Gemini глобальны и `override`
   * игнорируют. Строится через `os.homedir()` + `path.join` — кроссплатформенно.
   */
  instructionsFile?: (override?: string) => string;
  /**
   * Конфигурация со СПИСКОМ ССЫЛОК на файлы инструкций — АЛЬТЕРНАТИВА
   * `instructionsFile` (AIDER-1). Задана только у Aider: единого файла инструкций
   * у него нет, файлы контекста подключаются опцией `read` в `.aider.conf.yml`.
   * Задавать обе модели одновременно нельзя. Нет ни одной → раздел инструкций
   * fail-closed.
   */
  instructionsList?: ProviderInstructionsListLocation;
  /**
   * КАТАЛОГ ПРАВИЛ — третья, взаимоисключающая с двумя другими модель раздела
   * инструкций (CURSOR-1). Задан только у Cursor: у него правила это каталог
   * `~/.cursor/rules/*.mdc` (много файлов с frontmatter), а не файл и не список.
   * Задавать больше одной модели одновременно нельзя. Нет ни одной → раздел
   * инструкций fail-closed.
   */
  instructionsRules?: ProviderInstructionsRulesLocation;
  /**
   * Расположение и формат файла MCP-серверов — задан только у провайдеров с
   * реализованным адаптером (Codex/Gemini), у них же `mcp` = `ready`. Отсутствует
   * → универсальный раздел MCP провайдер не поддерживает (fail-closed). Claude
   * обслуживается своими роутами и `mcpConfig` здесь не имеет.
   */
  mcpConfig?: ProviderMcpConfigLocation;
  /**
   * Расположение и формат файла переменных окружения — задан только у
   * провайдеров с реализованным адаптером (Codex: `[shell_environment_policy.set]`
   * в config.toml), у них же `env` = `ready`. Отсутствует → универсальный раздел
   * env провайдер не поддерживает (fail-closed). Claude пишет env в settings.json
   * своими роутами и `envConfig` здесь не имеет; Gemini env остаётся `planned`.
   */
  envConfig?: ProviderEnvConfigLocation;
  /**
   * Расположение и формат файла прав/аппрувов — задан только у провайдеров с
   * реализованным адаптером (Codex: скалярные ключи корня `approval_policy` /
   * `sandbox_mode` в config.toml), у них же `permissions` = `ready`. Отсутствует →
   * универсальный раздел прав провайдер не поддерживает (fail-closed). Claude пишет
   * права в settings.json своими роутами и `permissionsConfig` здесь не имеет;
   * gemini/opencode остаются `planned`.
   */
  permissionsConfig?: ProviderPermissionsConfigLocation;
  /**
   * Расположение и формат ХУКОВ (OPENCODE-3) — задан только у провайдеров с
   * реализованным адаптером (OpenCode: ключ `experimental.hook` в opencode.json),
   * у них же `hooks` = `ready`. Отсутствует → универсальный раздел хуков
   * провайдер не поддерживает (fail-closed). У Claude своя, принципиально иная
   * модель хуков на собственных маршрутах — `hooksConfig` здесь он не имеет.
   */
  hooksConfig?: ProviderHooksConfigLocation;
  /**
   * Расположение ПЛАГИНОВ (OPENCODE-4) — задан только у провайдеров с
   * реализованным адаптером (OpenCode: каталог `plugins/` + массив `plugin` в
   * opencode.json), у них же `plugins` = `ready`. Отсутствует → универсальный
   * раздел плагинов провайдер не поддерживает (fail-closed). Раздел «Плагины» у
   * Claude — расширения самой панели, `pluginsConfig` здесь он не имеет.
   */
  pluginsConfig?: ProviderPluginsConfigLocation;
  /**
   * Расположение СКИЛЛОВ (OPENCODE-5) — задан только у провайдеров с
   * реализованным адаптером (OpenCode: каталог `skills/` с папками `SKILL.md`),
   * у них же `skills` = `ready`. Отсутствует → универсальный раздел скиллов
   * провайдер не поддерживает (fail-closed). У Claude свой богатый раздел
   * скиллов на собственных маршрутах — `skillsConfig` здесь он не имеет.
   */
  skillsConfig?: ProviderSkillsConfigLocation;
  /**
   * Проектный уровень конфигурации — задан только у провайдеров с
   * задокументированными проектными путями (Codex/Gemini/OpenCode/Cursor), у них
   * же `projects` = `ready`. Отсутствует → универсальный проектный раздел
   * провайдер не поддерживает (fail-closed). У Claude свой богатый проектный
   * уровень на собственных маршрутах, `projectConfig` здесь он не имеет.
   */
  projectConfig?: ProviderProjectConfigLocation;
  /**
   * Каталоги/файлы конфигурации провайдера — ТОЛЬКО для детекта «конфиг найден»
   * (Ф7). Проверяется существование (`existsSync`), содержимое НЕ читается, в эти
   * пути ничего не пишется: детект — подсказка интерфейсу, не адаптер файлов.
   *
   * Задан там, где расположение задокументировано (claude `~/.claude`, codex
   * `~/.codex`, gemini `~/.gemini`, cursor `~/.cursor`, opencode
   * `~/.config/opencode` | `~/.opencode`, aider `~/.aider.conf.yml` и др.).
   * Достаточно существования ЛЮБОГО из перечисленных путей. Не задан → детект
   * конфигурации не делается (`configPresent=false`, пути не угадываем).
   *
   * Аргумент `override` — пользовательский каталог конфигурации: его уважает
   * только Claude; остальные провайдеры глобальны и `override` игнорируют.
   */
  configLocations?: (override?: string) => string[];
  /**
   * Метаданные ассистента (мульти-модельность, Ф6a): тип модельного API,
   * стандартные env-переменные ключа и возможность запуска через CLI. По ним
   * панель резолвит раннер (`api`/`cli`/`none`). Задан у всех провайдеров; у
   * Cursor `apiKind='none'` + `cliRunnable=false` — ассистент unsupported.
   */
  assistant?: ProviderAssistant;
  /**
   * Вендоры каталога моделей (models.dev), чьи модели относятся к этому CLI:
   * claude → `anthropic`, codex → `openai`, gemini → `google`, qwen →
   * `alibaba`, kimi → `moonshotai`, opencode → его собственный шлюз `opencode`.
   *
   * Не задан — раздел моделей у провайдера fail-closed: Continue, Goose, Aider
   * и Cursor это оболочки поверх любых моделей, и решать за пользователя, чей
   * список ему показать, панель не станет.
   */
  modelVendors?: string[];
}
