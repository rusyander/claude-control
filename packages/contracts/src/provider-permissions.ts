import {
  object,
  string,
  array,
  literal,
  union,
  discriminatedUnion,
  enum as zodEnum,
  boolean,
  type infer as Infer,
} from 'zod';

/**
 * Универсальная модель прав/аппрувов провайдера. Моделей ВОСЕМЬ, потому что и у CLI
 * они принципиально разные — общего знаменателя нет, и выдумывать его нельзя:
 *
 * - **Codex** (`kind: 'codex'`, файл `~/.codex/config.toml`) — два СКАЛЯРНЫХ
 *   ключа корня: `approval_policy` (когда спрашивать подтверждение) и
 *   `sandbox_mode` (границы файловой системы и сети);
 * - **Gemini** (`kind: 'gemini'`, файл `~/.gemini/settings.json` и проектный
 *   `<проект>/.gemini/settings.json`) — режим аппрувов
 *   `general.defaultApprovalMode` плюс два списка инструментов: `coreTools`
 *   (белый список) и `excludeTools` (чёрный список, приоритетнее белого);
 * - **Qwen Code** (`kind: 'qwen'`, файл `~/.qwen/settings.json` и проектный
 *   `<проект>/.qwen/settings.json`) — режим аппрувов `tools.approvalMode` плюс ТРИ
 *   списка ПРАВИЛ: `permissions.allow` / `permissions.ask` / `permissions.deny`.
 *   Qwen — форк Gemini CLI, но ключи прав у него другие (у Gemini
 *   `general.defaultApprovalMode` и `coreTools`/`excludeTools`), поэтому и модель
 *   отдельная;
 * - **Continue** (`kind: 'continue'`, ОТДЕЛЬНЫЙ файл `~/.continue/permissions.yaml`)
 *   — режима нет вовсе, есть ровно три списка правил: `allow` (выполнять сразу),
 *   `ask` (спрашивать) и `exclude` (спрятать инструмент от агента);
 * - **Goose** (`kind: 'goose'`, файл `~/.config/goose/config.yaml`, на Windows
 *   `%APPDATA%\Block\goose\config\config.yaml`) — ровно ОДИН скалярный ключ
 *   корня `GOOSE_MODE`: списков у этой модели нет вовсе;
 * - **OpenCode** (`kind: 'opencode'`, файл `~/.config/opencode/opencode.json` и
 *   проектный `<проект>/opencode.json`) — ключ `permission`: у каждого
 *   инструмента свой уровень `allow` | `deny` | `ask`, а у `bash` вместо уровня
 *   может стоять КАРТА ШАБЛОНОВ команды («git push *» → `deny`);
 * - **Kimi Code** (`kind: 'kimi'`, файл `~/.kimi-code/config.toml`) — режим
 *   `default_permission_mode` плюс УПОРЯДОЧЕННЫЙ список правил
 *   `[[permission.rules]]` (решение + шаблон);
 * - **Cursor** (`kind: 'cursor'`, глобальный `~/.cursor/cli-config.json` и
 *   проектный `<проект>/.cursor/cli.json`) — ключ `permissions` с ДВУМЯ списками
 *   правил: `allow` и `deny`, причём `deny` приоритетнее. Режима-переключателя
 *   у Cursor нет, третьего списка (`ask`) — тоже: правила задаются формами
 *   `Shell(...)`, `Read(...)`, `Write(...)`, `WebFetch(...)`, `Mcp(сервер:инструмент)`.
 *
 * Раздел прав Claude остаётся на своей богатой модели (`settings.json`
 * permissions allow/deny/ask) БЕЗ изменений — эта модель им не пользуется.
 * Провайдеры без реализованного адаптера сюда не попадают (fail-closed).
 */

/** Политика аппрувов Codex: когда запрашивать подтверждение. */
export const codexApprovalPolicies = ['untrusted', 'on-request', 'never'] as const;
export type CodexApprovalPolicy = (typeof codexApprovalPolicies)[number];

/** Режим песочницы Codex: границы файловой системы и сети. */
export const codexSandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof codexSandboxModes)[number];

/**
 * Режимы аппрувов Gemini, ДОПУСТИМЫЕ в `settings.json`
 * (`general.defaultApprovalMode`):
 * - `default` — спрашивать подтверждение перед каждым вызовом инструмента;
 * - `auto_edit` — правки файлов подтверждаются автоматически, shell — по-прежнему
 *   с вопросом;
 * - `plan` — только чтение и планирование, изменений CLI не делает.
 *
 * `yolo` в этот список НЕ входит СОЗНАТЕЛЬНО: по документации Gemini это режим
 * только для флага командной строки, а записанный в `settings.json` он вызывает
 * ошибку enum при старте CLI. Панель его не пишет никогда (сервер отвечает 400).
 */
export const geminiApprovalModes = ['default', 'auto_edit', 'plan'] as const;
export type GeminiApprovalMode = (typeof geminiApprovalModes)[number];

/**
 * Значение режима аппрувов, которое панель отказывается записывать в файл, —
 * `yolo` (см. `geminiApprovalModes`). Держим значением, чтобы и сервер, и
 * интерфейс объясняли отказ одинаково.
 */
export const geminiForbiddenApprovalModes = ['yolo'] as const;
export type GeminiForbiddenApprovalMode = (typeof geminiForbiddenApprovalModes)[number];

/**
 * Режимы аппрувов Qwen Code (`tools.approvalMode` в `settings.json`) — все пять
 * задокументированы ИМЕННО как значения файла настроек (пример с `"yolo"` есть в
 * документации), поэтому запрещённого набора, как у Gemini, здесь нет:
 * - `plan` — только анализ и план, ничего не выполняется;
 * - `default` — спрашивать подтверждение перед каждым действием;
 * - `auto-edit` — правки файлов подтверждаются автоматически;
 * - `auto` — автономный режим (жёсткие правила `permissions.deny` продолжают действовать);
 * - `yolo` — подтверждается ВСЁ, включая команды оболочки.
 */
export const qwenApprovalModes = ['default', 'plan', 'auto-edit', 'auto', 'yolo'] as const;
export type QwenApprovalMode = (typeof qwenApprovalModes)[number];

/**
 * Уровни прав OpenCode (ключ `permission` в `opencode.json`):
 * - `allow` — выполнять без вопроса;
 * - `ask` — спрашивать подтверждение перед каждым вызовом;
 * - `deny` — запретить полностью.
 *
 * Других значений у OpenCode нет: всё, что вне набора, сервер отклоняет до записи.
 */
export const opencodePermissionLevels = ['allow', 'deny', 'ask'] as const;
export type OpencodePermissionLevel = (typeof opencodePermissionLevels)[number];

/**
 * Инструменты OpenCode, у которых уровень прав ЗАДОКУМЕНТИРОВАН: правка файлов,
 * запуск команд оболочки и загрузка страниц из сети. Прочие ключи внутри
 * `permission` панель не ведёт — они сохраняются как есть и показываются только
 * для чтения (переопределения на уровне агента живут вне `permission` и не
 * затрагиваются вовсе).
 */
export const opencodePermissionTools = ['edit', 'bash', 'webfetch'] as const;
export type OpencodePermissionTool = (typeof opencodePermissionTools)[number];

/** Строка карты шаблонов: шаблон команды → уровень (расширенная форма `bash`). */
export const opencodePatternRuleSchema = object({
  /** Шаблон команды (`*`, `git *`, `git push *`). */
  pattern: string(),
  level: zodEnum(opencodePermissionLevels),
});
export type OpencodePatternRule = Infer<typeof opencodePatternRuleSchema>;

/**
 * Права одного инструмента OpenCode: либо простой уровень (`mode: 'level'`),
 * либо карта шаблонов (`mode: 'patterns'`, задокументирована для `bash`).
 * Инструмента нет в списке → ограничение не задано, ключ в файле отсутствует.
 */
export const opencodePermissionEntrySchema = object({
  tool: zodEnum(opencodePermissionTools),
  mode: zodEnum(['level', 'patterns']),
  /** Уровень простой формы (задан при `mode: 'level'`). */
  level: zodEnum(opencodePermissionLevels).optional(),
  /** Карта шаблонов в порядке файла (задана при `mode: 'patterns'`). */
  patterns: array(opencodePatternRuleSchema).optional(),
});
export type OpencodePermissionEntry = Infer<typeof opencodePermissionEntrySchema>;

/** Запись внутри `permission`, которую панель не ведёт: только для чтения. */
export const opencodePreservedEntrySchema = object({
  key: string(),
  /** Значение в компактном JSON — показывается как есть, в файле не меняется. */
  value: string(),
});
export type OpencodePreservedEntry = Infer<typeof opencodePreservedEntrySchema>;

/** Общие для всех моделей метаданные раздела. */
const permissionInfoBase = {
  /** Id активного провайдера (`codex` / `gemini`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера — для заголовка раздела. */
  providerName: string(),
  /** Абсолютный путь к файлу конфигурации прав активного провайдера. */
  filePath: string(),
  /** Обнаружен ли CLI провайдера (по наличию его каталога конфигурации). */
  cliDetected: boolean(),
  /** Значения ещё не заданы в файле — показаны дефолты CLI (молча не пишутся). */
  usingDefaults: boolean(),
  /** Формат не распознан → раздел только для чтения (запись запрещена). */
  readOnly: boolean().default(false),
  /** Текст ошибки, если формат не распознан. */
  error: string().optional(),
};

/** Права Codex: два скалярных ключа корня `config.toml`. */
export const codexPermissionInfoSchema = object({
  kind: literal('codex'),
  /** Формат файла конфигурации Codex. */
  format: literal('toml'),
  /** Текущая политика аппрувов. */
  approvalPolicy: zodEnum(codexApprovalPolicies),
  /** Текущий режим песочницы. */
  sandboxMode: zodEnum(codexSandboxModes),
  /** Допустимые значения политики аппрувов (для селекта). */
  approvalPolicies: array(zodEnum(codexApprovalPolicies)),
  /** Допустимые значения режима песочницы (для селекта). */
  sandboxModes: array(zodEnum(codexSandboxModes)),
  ...permissionInfoBase,
});

export type CodexPermissionInfo = Infer<typeof codexPermissionInfoSchema>;

/** Права Gemini: режим аппрувов + белый и чёрный списки инструментов. */
export const geminiPermissionInfoSchema = object({
  kind: literal('gemini'),
  /** Формат файла конфигурации Gemini (settings.json, правится точечно). */
  format: literal('gemini-json'),
  /** Текущий режим аппрувов (`general.defaultApprovalMode`). */
  approvalMode: zodEnum(geminiApprovalModes),
  /** Допустимые значения режима аппрувов (для селекта). `yolo` сюда не входит. */
  approvalModes: array(zodEnum(geminiApprovalModes)),
  /** Белый список инструментов (`coreTools`): разрешено только перечисленное. */
  coreTools: array(string()),
  /** Чёрный список инструментов (`excludeTools`): приоритетнее белого. */
  excludeTools: array(string()),
  ...permissionInfoBase,
});

export type GeminiPermissionInfo = Infer<typeof geminiPermissionInfoSchema>;

/** Права Qwen Code: режим аппрувов + три списка правил `permissions.*`. */
export const qwenPermissionInfoSchema = object({
  kind: literal('qwen'),
  /** Формат файла Qwen Code (settings.json, правятся только ключи прав). */
  format: literal('qwen-json'),
  /** Текущий режим аппрувов (`tools.approvalMode`). */
  approvalMode: zodEnum(qwenApprovalModes),
  /** Допустимые значения режима аппрувов (для селекта). */
  approvalModes: array(zodEnum(qwenApprovalModes)),
  /** `permissions.allow` — выполнять без вопроса (`Bash(git status)`, `Read(/src/**)`). */
  allow: array(string()),
  /** `permissions.ask` — всегда спрашивать подтверждение. */
  ask: array(string()),
  /** `permissions.deny` — запретить полностью; приоритетнее прочих. */
  deny: array(string()),
  ...permissionInfoBase,
});

export type QwenPermissionInfo = Infer<typeof qwenPermissionInfoSchema>;

/** Права OpenCode: ключ `permission` в `opencode.json` (OPENCODE-1). */
export const opencodePermissionInfoSchema = object({
  kind: literal('opencode'),
  /** Формат файла OpenCode (правится ТОЛЬКО ключ `permission`). */
  format: literal('opencode-json'),
  /** Допустимые уровни (для селектов). */
  levels: array(zodEnum(opencodePermissionLevels)),
  /** Задокументированные инструменты — по ним строится форма. */
  tools: array(zodEnum(opencodePermissionTools)),
  /** Инструменты, у которых панель умеет карту шаблонов (сейчас — `bash`). */
  patternTools: array(zodEnum(opencodePermissionTools)),
  /** Что реально задано в файле (инструменты без записи ограничений не имеют). */
  entries: array(opencodePermissionEntrySchema),
  /** Записи `permission`, которые панель не ведёт: сохраняются, только чтение. */
  preserved: array(opencodePreservedEntrySchema),
  ...permissionInfoBase,
});

export type OpencodePermissionInfo = Infer<typeof opencodePermissionInfoSchema>;

/** Права Continue: три списка правил в отдельном `permissions.yaml`, без режима. */
export const continuePermissionInfoSchema = object({
  kind: literal('continue'),
  /** Формат файла Continue (`permissions.yaml`, правится Document API). */
  format: literal('continue-yaml'),
  /** `allow` — выполнять сразу, без вопроса. */
  allow: array(string()),
  /** `ask` — спрашивать подтверждение (в headless-режиме такой инструмент недоступен). */
  ask: array(string()),
  /** `exclude` — вообще спрятать инструмент от агента. */
  exclude: array(string()),
  ...permissionInfoBase,
});

export type ContinuePermissionInfo = Infer<typeof continuePermissionInfoSchema>;

/**
 * Правила Cursor, чьи формы ЗАДОКУМЕНТИРОВАНЫ: `Shell(команда)`, `Read(путь)`,
 * `Write(путь)`, `WebFetch(домен)`, `Mcp(сервер:инструмент)`. Список нужен только
 * для подсказок в интерфейсе — панель правила НЕ толкует и хранит их как есть
 * (иначе она бы молча резала то, чего не поняла).
 */
export const cursorPermissionKinds = ['Shell', 'Read', 'Write', 'WebFetch', 'Mcp'] as const;
export type CursorPermissionKind = (typeof cursorPermissionKinds)[number];

/** Права Cursor: два списка правил в `permissions`, без режима и без `ask`. */
export const cursorPermissionInfoSchema = object({
  kind: literal('cursor'),
  /** Формат файла Cursor (`cli-config.json` / `cli.json`, правится точечно). */
  format: literal('cursor-json'),
  /** `permissions.allow` — выполнять без вопроса. */
  allow: array(string()),
  /** `permissions.deny` — запретить; приоритетнее `allow`. */
  deny: array(string()),
  /** Задокументированные формы правил — для подсказки в форме. */
  ruleKinds: array(zodEnum(cursorPermissionKinds)),
  ...permissionInfoBase,
});

export type CursorPermissionInfo = Infer<typeof cursorPermissionInfoSchema>;

/** Режимы аппрувов Goose: значение корневого ключа `GOOSE_MODE`. */
export const gooseModes = ['auto', 'approve', 'smart_approve', 'chat'] as const;
export type GooseMode = (typeof gooseModes)[number];

/** Права Goose: один режим в корне `config.yaml`, без списков. */
export const goosePermissionInfoSchema = object({
  kind: literal('goose'),
  /** Формат файла Goose (`config.yaml`, правится Document API). */
  format: literal('goose-yaml'),
  /** Текущее значение `GOOSE_MODE` (или дефолт CLI, если ключа нет). */
  mode: zodEnum(gooseModes),
  /** Все допустимые режимы — список для формы. */
  modes: array(zodEnum(gooseModes)),
  /**
   * Пофайловые разрешения инструментов из `permission.yaml` — ТОЛЬКО ПОКАЗ.
   * Формата этого файла в документации Goose нет (задокументированы лишь три
   * уровня и путь настройки `goose configure`), поэтому панель его не пишет.
   * Ничего не настроено или форма незнакомая → поля нет.
   */
  toolPermissions: object({
    alwaysAllow: array(string()),
    askBefore: array(string()),
    neverAllow: array(string()),
  }).optional(),
  /** Путь к `permission.yaml` — человеку нужно знать, какой файл смотреть. */
  toolPermissionsPath: string().optional(),
  ...permissionInfoBase,
});

export type GoosePermissionInfo = Infer<typeof goosePermissionInfoSchema>;

/** Режимы аппрувов Kimi Code: значение корневого ключа `default_permission_mode`. */
export const kimiModes = ['manual', 'auto', 'yolo'] as const;
export type KimiMode = (typeof kimiModes)[number];

/** Решение правила Kimi: что делать с подходящим вызовом инструмента. */
export const kimiDecisions = ['allow', 'ask', 'deny'] as const;
export type KimiDecision = (typeof kimiDecisions)[number];

/**
 * Правило Kimi — элемент массива таблиц `[[permission.rules]]`: решение плюс
 * шаблон вида `Read`, `Bash(rm -rf*)`, `mcp__github__*`.
 */
export const kimiPermissionRuleSchema = object({
  decision: zodEnum(kimiDecisions),
  pattern: string(),
});

export type KimiPermissionRule = Infer<typeof kimiPermissionRuleSchema>;

/** Права Kimi Code: режим в корне `config.toml` + упорядоченный список правил. */
export const kimiPermissionInfoSchema = object({
  kind: literal('kimi'),
  /** Формат файла Kimi (`config.toml`, хирургическая правка). */
  format: literal('kimi-toml'),
  /** Текущее значение `default_permission_mode` (или дефолт CLI, если ключа нет). */
  mode: zodEnum(kimiModes),
  /** Все допустимые режимы — список для формы. */
  modes: array(zodEnum(kimiModes)),
  /** Правила в порядке файла: порядок значим для пользователя. */
  rules: array(kimiPermissionRuleSchema),
  /** Все допустимые решения — список для формы. */
  decisions: array(zodEnum(kimiDecisions)),
  ...permissionInfoBase,
});

export type KimiPermissionInfo = Infer<typeof kimiPermissionInfoSchema>;

/**
 * Ответ раздела прав провайдера — размеченное объединение по `kind`: интерфейс
 * рисует форму той модели, которую вернул сервер, и никогда не смешивает их.
 */
export const providerPermissionInfoSchema = discriminatedUnion('kind', [
  codexPermissionInfoSchema,
  geminiPermissionInfoSchema,
  qwenPermissionInfoSchema,
  continuePermissionInfoSchema,
  goosePermissionInfoSchema,
  kimiPermissionInfoSchema,
  opencodePermissionInfoSchema,
  cursorPermissionInfoSchema,
]);

export type ProviderPermissionInfo = Infer<typeof providerPermissionInfoSchema>;

/**
 * Тело запроса на сохранение прав Codex. Значения вне разрешённых наборов сервер
 * отклоняет ДО записи (400).
 */
export const codexPermissionDraftSchema = object({
  approvalPolicy: zodEnum(codexApprovalPolicies),
  sandboxMode: zodEnum(codexSandboxModes),
});

export type CodexPermissionDraft = Infer<typeof codexPermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Gemini: режим аппрувов + оба списка
 * инструментов целиком (bulk-replace). Режим вне `geminiApprovalModes` (в том
 * числе `yolo`) сервер отклоняет ДО записи (400) — в файл он не попадает.
 */
export const geminiPermissionDraftSchema = object({
  approvalMode: zodEnum(geminiApprovalModes),
  coreTools: array(string()),
  excludeTools: array(string()),
});

export type GeminiPermissionDraft = Infer<typeof geminiPermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Qwen Code: режим аппрувов + все три списка
 * правил целиком (bulk-replace). Пустой список УДАЛЯЕТ свой ключ, а пустые все
 * три — весь объект `permissions`. Режим вне `qwenApprovalModes` сервер отклоняет
 * ДО записи (400).
 */
export const qwenPermissionDraftSchema = object({
  approvalMode: zodEnum(qwenApprovalModes),
  allow: array(string()),
  ask: array(string()),
  deny: array(string()),
});

export type QwenPermissionDraft = Infer<typeof qwenPermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Continue: три списка целиком (bulk-replace).
 * Пустой список УДАЛЯЕТ свой ключ в `permissions.yaml`. Режима у Continue нет —
 * если он придёт в теле, сервер его просто не читает.
 */
export const continuePermissionDraftSchema = object({
  allow: array(string()),
  ask: array(string()),
  exclude: array(string()),
});

export type ContinuePermissionDraft = Infer<typeof continuePermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Cursor: оба списка целиком (bulk-replace).
 * Пустой список УДАЛЯЕТ свой ключ, пустые оба — весь объект `permissions`.
 * Режима у Cursor нет; списка `ask` у него тоже нет — присланный, он не читается.
 */
export const cursorPermissionDraftSchema = object({
  allow: array(string()),
  deny: array(string()),
});

export type CursorPermissionDraft = Infer<typeof cursorPermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Goose: один режим. Значение вне `gooseModes`
 * сервер отклоняет ДО записи (400) — в `config.yaml` оно не попадает.
 */
export const goosePermissionDraftSchema = object({
  mode: zodEnum(gooseModes),
});

export type GoosePermissionDraft = Infer<typeof goosePermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав Kimi: режим + ВЕСЬ список правил целиком
 * (bulk-replace, порядок сохраняется). Пустой список удаляет регион
 * `[[permission.rules]]`. Значение вне наборов сервер отклоняет ДО записи (400).
 */
export const kimiPermissionDraftSchema = object({
  mode: zodEnum(kimiModes),
  rules: array(kimiPermissionRuleSchema),
});

export type KimiPermissionDraft = Infer<typeof kimiPermissionDraftSchema>;

/**
 * Тело запроса на сохранение прав OpenCode: полный набор ЗАДАННЫХ ограничений.
 * Инструмента нет в списке → его ключ удаляется из `permission` (ограничение
 * снято). Уровень вне набора, карта шаблонов у инструмента, для которого она не
 * задокументирована, и пустая карта — сервер отклоняет ДО записи (400).
 */
export const opencodePermissionDraftSchema = object({
  entries: array(opencodePermissionEntrySchema),
});

export type OpencodePermissionDraft = Infer<typeof opencodePermissionDraftSchema>;

/** Черновик прав любой из поддержанных моделей — по формату файла провайдера. */
export const providerPermissionDraftSchema = union([
  codexPermissionDraftSchema,
  geminiPermissionDraftSchema,
  qwenPermissionDraftSchema,
  continuePermissionDraftSchema,
  goosePermissionDraftSchema,
  kimiPermissionDraftSchema,
  opencodePermissionDraftSchema,
  cursorPermissionDraftSchema,
]);

export type ProviderPermissionDraft = Infer<typeof providerPermissionDraftSchema>;
