/**
 * ГЛОБАЛЬНЫЕ разделы провайдера: где лежит файл (или каталог) раздела и каким
 * адаптером формата он правится. Общее правило у всех — поле задаётся ТОЛЬКО
 * там, где формат подтверждён документацией и адаптер реально написан; иначе
 * раздел fail-closed (сервер отвечает 4xx) и панель в чужой конфиг не пишет.
 *
 * Раздел инструкций живёт отдельно (`./instructions.ts`): у него три модели.
 */

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
  /**
   * Каталог файлов-блоков (Continue): рядом с основным конфигом лежит папка,
   * каждый `*.yaml`/`*.yml` в которой несёт СВОЙ список `mcpServers` (шапка
   * блока — `name` / `version` / `schema`). Continue грузит их вместе с
   * основным файлом, поэтому раздел показывает и те, и другие, а правка идёт в
   * тот файл, где запись лежит. Задан только у формата `continue-yaml`.
   */
  blockDir?: (override?: string) => string;
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
  /**
   * ТОЛЬКО ЧТЕНИЕ: отдельный файл пофайловых разрешений инструментов (Goose —
   * `permission.yaml` рядом с `config.yaml`). Панель его показывает, но НЕ
   * пишет: формата в опубликованной документации нет, известен он лишь из
   * исходников CLI, а угадывать чужой формат правило запрещает.
   */
  readOnlyToolPermissionsPath?: (override?: string) => string;
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
 * Расположение ФАЙЛОВ СЛЭШ-КОМАНД провайдера.
 *
 * Формат берётся ТОЛЬКО из документации CLI: у Gemini и его форка Qwen это
 * каталог `commands` с файлами `.toml` (обязательное поле `prompt`, необязательное
 * `description`; подкаталог даёт пространство имён — `git/fix.toml` вызывается
 * как `/git:fix`), у OpenCode — `commands/*.md` с YAML-шапкой (`description`,
 * `agent`, `model`), а ДОПОЛНИТЕЛЬНО команды можно задать ключом `command` в
 * самом конфиге. Раздел читающий: панель эти файлы не пишет.
 */
export interface ProviderCommandsConfigLocation {
  /** `toml-prompt` — Gemini/Qwen; `md-frontmatter` — OpenCode. */
  format: 'toml-prompt' | 'md-frontmatter';
  /** Абсолютный путь КАТАЛОГА команд. */
  dir: (override?: string) => string;
  /**
   * Файл конфигурации, в котором команды могут быть объявлены ключом (у
   * OpenCode — `command` в `opencode.json`). Не задан → команды только файлами.
   */
  configPath?: (override?: string) => string;
  /**
   * Разделитель пространства имён из подкаталогов. Задан у Gemini/Qwen (`:`),
   * у остальных вложенность не задокументирована → подкаталоги не разбираем.
   */
  namespaceSeparator?: string;
}
