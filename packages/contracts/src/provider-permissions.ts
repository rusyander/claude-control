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
 * Универсальная модель прав/аппрувов провайдера. Моделей ДВЕ, потому что и у CLI
 * они принципиально разные — общего знаменателя нет, и выдумывать его нельзя:
 *
 * - **Codex** (`kind: 'codex'`, файл `~/.codex/config.toml`) — два СКАЛЯРНЫХ
 *   ключа корня: `approval_policy` (когда спрашивать подтверждение) и
 *   `sandbox_mode` (границы файловой системы и сети);
 * - **Gemini** (`kind: 'gemini'`, файл `~/.gemini/settings.json` и проектный
 *   `<проект>/.gemini/settings.json`) — режим аппрувов
 *   `general.defaultApprovalMode` плюс два списка инструментов: `coreTools`
 *   (белый список) и `excludeTools` (чёрный список, приоритетнее белого).
 *
 * Раздел прав Claude остаётся на своей богатой модели (`settings.json`
 * permissions allow/deny/ask) БЕЗ изменений — эта модель им не пользуется.
 * Провайдеры без реализованного адаптера (opencode) сюда не попадают (fail-closed).
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

/** Общие для обеих моделей метаданные раздела. */
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

/**
 * Ответ раздела прав провайдера — размеченное объединение по `kind`: интерфейс
 * рисует форму той модели, которую вернул сервер, и никогда не смешивает их.
 */
export const providerPermissionInfoSchema = discriminatedUnion('kind', [
  codexPermissionInfoSchema,
  geminiPermissionInfoSchema,
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

/** Черновик прав любой из поддержанных моделей — по формату файла провайдера. */
export const providerPermissionDraftSchema = union([
  codexPermissionDraftSchema,
  geminiPermissionDraftSchema,
]);

export type ProviderPermissionDraft = Infer<typeof providerPermissionDraftSchema>;
