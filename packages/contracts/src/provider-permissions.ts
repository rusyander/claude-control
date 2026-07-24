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
 * Универсальная модель прав/аппрувов провайдера. Моделей ТРИ, потому что и у CLI
 * они принципиально разные — общего знаменателя нет, и выдумывать его нельзя:
 *
 * - **Codex** (`kind: 'codex'`, файл `~/.codex/config.toml`) — два СКАЛЯРНЫХ
 *   ключа корня: `approval_policy` (когда спрашивать подтверждение) и
 *   `sandbox_mode` (границы файловой системы и сети);
 * - **Gemini** (`kind: 'gemini'`, файл `~/.gemini/settings.json` и проектный
 *   `<проект>/.gemini/settings.json`) — режим аппрувов
 *   `general.defaultApprovalMode` плюс два списка инструментов: `coreTools`
 *   (белый список) и `excludeTools` (чёрный список, приоритетнее белого);
 * - **OpenCode** (`kind: 'opencode'`, файл `~/.config/opencode/opencode.json` и
 *   проектный `<проект>/opencode.json`) — ключ `permission`: у каждого
 *   инструмента свой уровень `allow` | `deny` | `ask`, а у `bash` вместо уровня
 *   может стоять КАРТА ШАБЛОНОВ команды («git push *» → `deny`).
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

/**
 * Ответ раздела прав провайдера — размеченное объединение по `kind`: интерфейс
 * рисует форму той модели, которую вернул сервер, и никогда не смешивает их.
 */
export const providerPermissionInfoSchema = discriminatedUnion('kind', [
  codexPermissionInfoSchema,
  geminiPermissionInfoSchema,
  opencodePermissionInfoSchema,
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
  opencodePermissionDraftSchema,
]);

export type ProviderPermissionDraft = Infer<typeof providerPermissionDraftSchema>;
