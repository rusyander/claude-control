import type { ClaudePaths } from '@claude-control/contracts';
import type { CapabilityMap, ProviderStatus } from './capabilities.ts';
import type { ProviderAssistant, ProviderCli } from './assistant.ts';
import type {
  ProviderInstructionsListLocation,
  ProviderInstructionsRulesLocation,
} from './instructions.ts';
import type {
  ProviderCommandsConfigLocation,
  ProviderEnvConfigLocation,
  ProviderHooksConfigLocation,
  ProviderMcpConfigLocation,
  ProviderPermissionsConfigLocation,
  ProviderPluginsConfigLocation,
  ProviderSkillsConfigLocation,
} from './sections.ts';

/**
 * Провайдер конфигурации на стороне сервера (мульти-провайдерность).
 *
 * Логика Claude — адаптер #1, поведение не меняется. Провайдер инкапсулирует
 * четыре вещи, различающиеся между CLI: где лежат файлы (`paths`), чем
 * запускается инструмент (`cli`), насколько он проверен (`status`) и что из
 * разделов панели он поддерживает (`capabilities` — карта статусов).
 */

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
    /**
     * Каталог файлов-блоков внутри проекта (Continue: `.continue/mcpServers`) —
     * тот же механизм, что и у глобального `blockDir`. Разделитель — `/`.
     */
    relativeBlockDir?: string;
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
   * Расположение ФАЙЛОВ КОМАНД — задано только там, где формат слэш-команд
   * задокументирован (Gemini/Qwen: `commands/*.toml`, OpenCode: `commands/*.md`
   * плюс ключ `command` в конфиге). Отсутствует → раздел команд у провайдера
   * `unsupported`: угадывать, где чужой CLI держит команды, нельзя. У Claude
   * команд несколько источников сразу (скиллы, `commands/`, плагины), поэтому у
   * него собственная сборка, а не `commandsConfig`.
   */
  commandsConfig?: ProviderCommandsConfigLocation;
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
