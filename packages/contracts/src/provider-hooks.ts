import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Хуки провайдера (OPENCODE-3) — МОДЕЛЬ, ОТЛИЧНАЯ ОТ ХУКОВ CLAUDE.
 *
 * У Claude хуки живут в `settings.json` событиями вроде `PreToolUse`/`PostToolUse`
 * с матчерами инструментов и shell-командами — это отдельный богатый раздел на
 * своих маршрутах (`/api/hooks`), и он не меняется ни на пиксель.
 *
 * У OpenCode устроено иначе: ключ `experimental.hook` в `opencode.json`, ровно
 * ДВА задокументированных события, действия — argv-массивы, а не shell-строки:
 *
 * ```jsonc
 * "experimental": { "hook": {
 *   "file_edited": { "*.ts": [ { "command": ["prettier","--write"],
 *                               "environment": { "NODE_ENV": "development" } } ] },
 *   "session_completed": [ { "command": ["notify-send","Session completed!"] } ]
 * } }
 * ```
 *
 * ВАЖНО И ЧЕСТНО: ключ лежит под `experimental` — сам OpenCode называет такие
 * настройки нестабильными («may change or be removed without notice»). Панель
 * говорит это прямо в интерфейсе и не выдаёт раздел за стабильный API.
 */

/** Формат хранилища хуков (пока только OpenCode: ключ `experimental.hook`). */
export const providerHooksFormats = ['opencode-json'] as const;
export type ProviderHooksFormat = (typeof providerHooksFormats)[number];

/** Уровень: глобальный конфиг или конфиг проекта. */
export const providerHooksScopes = ['global', 'project'] as const;
export type ProviderHooksScope = (typeof providerHooksScopes)[number];

/** Пара переменной окружения действия. */
export const providerHookEnvVarSchema = object({
  key: string(),
  value: string(),
});

export type ProviderHookEnvVar = Infer<typeof providerHookEnvVarSchema>;

/**
 * Одно действие хука. `command` — МАССИВ аргументов (первый элемент — сама
 * программа): OpenCode запускает их без shell, поэтому пробелы внутри аргумента
 * безопасны, а склеивать всё в одну строку нельзя.
 */
export const providerHookActionSchema = object({
  command: array(string()),
  environment: array(providerHookEnvVarSchema).optional(),
});

export type ProviderHookAction = Infer<typeof providerHookActionSchema>;

/** Группа события `file_edited`: шаблон файлов и его действия. */
export const providerHookPatternGroupSchema = object({
  pattern: string(),
  actions: array(providerHookActionSchema),
});

export type ProviderHookPatternGroup = Infer<typeof providerHookPatternGroupSchema>;

/** Запись, которую панель не ведёт (чужое событие, чужой ключ `experimental`). */
export const providerHookPreservedEntrySchema = object({
  key: string(),
  value: string(),
});

export type ProviderHookPreservedEntry = Infer<typeof providerHookPreservedEntrySchema>;

/**
 * Сводка раздела хуков провайдера. `readOnly` = true, когда файл не разобран:
 * писать вслепую нельзя (fail-closed), раздел уходит в режим чтения.
 */
export const providerHooksInfoSchema = object({
  providerId: string(),
  providerName: string(),
  format: zodEnum(providerHooksFormats),
  scope: zodEnum(providerHooksScopes),
  /** Абсолютный путь конфигурации, в которой лежит ключ `experimental.hook`. */
  filePath: string(),
  /** Ключ `experimental.hook` в файле есть (иначе хуков просто нет). */
  present: boolean(),
  /** Группы `file_edited` — шаблон файлов → действия. */
  fileEdited: array(providerHookPatternGroupSchema),
  /** Действия `session_completed`. */
  sessionCompleted: array(providerHookActionSchema),
  /** События внутри `hook`, которых панель не знает — сохраняются как есть. */
  preservedEvents: array(providerHookPreservedEntrySchema),
  /** Прочие ключи внутри `experimental` — панель их не трогает. */
  preservedExperimental: array(providerHookPreservedEntrySchema),
  /** Файл не разобран → раздел только для чтения. */
  readOnly: boolean().default(false),
  /** Текст ошибки, если файл не разобран. */
  error: string().optional(),
});

export type ProviderHooksInfo = Infer<typeof providerHooksInfoSchema>;

/**
 * Тело запроса на запись хуков. Оба события передаются ЦЕЛИКОМ: пустой список
 * означает «этого события в файле быть не должно» (ключ удаляется, а не пишется
 * пустым). Записи, которых панель не ведёт, называть в черновике нельзя — сервер
 * ответит 422 и файл не тронет.
 */
export const providerHooksDraftSchema = object({
  fileEdited: array(providerHookPatternGroupSchema),
  sessionCompleted: array(providerHookActionSchema),
});

export type ProviderHooksDraft = Infer<typeof providerHooksDraftSchema>;
