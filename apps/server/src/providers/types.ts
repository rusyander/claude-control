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
   *   (OpenCode `opencode.json`).
   */
  format: 'json' | 'toml' | 'opencode-json';
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
  /** Формат каталога: `cursor-mdc` — файлы `.mdc` с YAML-frontmatter. */
  format: 'cursor-mdc';
  /** Абсолютный путь КАТАЛОГА правил (`~/.cursor/rules`). */
  dir: (override?: string) => string;
}

/**
 * Расположение и формат файла прав/аппрувов провайдера.
 *
 * Задаётся ТОЛЬКО у провайдеров с реализованным адаптером прав (Codex — скалярные
 * ключи корня `approval_policy` / `sandbox_mode` в config.toml; Gemini —
 * `general.defaultApprovalMode` + списки `coreTools`/`excludeTools` в
 * settings.json) — у них же `permissions` = `ready`. У Claude права живут в
 * settings.json (allow/deny/ask) и обслуживаются собственными богатыми роутами,
 * поэтому `permissionsConfig` у него НЕ задан. OpenCode (иная модель) сюда пока не
 * входит — его `permissions` остаётся `planned` (fail-closed). Провайдер без
 * `permissionsConfig` → универсальный раздел прав fail-closed (сервер отвечает 4xx).
 */
export interface ProviderPermissionsConfigLocation {
  /**
   * Формат файла:
   * - `toml` — скалярные ключи корня (Codex `config.toml`);
   * - `gemini-json` — `general.defaultApprovalMode` + `coreTools`/`excludeTools`
   *   (Gemini `settings.json`), правятся точечно, прочие ключи сохраняются.
   */
  format: 'toml' | 'gemini-json';
  /** Абсолютный путь к файлу конфигурации с правами/аппрувами. */
  path: (override?: string) => string;
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
}
