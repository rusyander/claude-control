import { object, string, number, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';

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
 * ВАЖНО И ЧЕСТНО: ключ лежал под `experimental` — сам OpenCode называет такие
 * настройки нестабильными («may change or be removed without notice»), и это
 * ровно то, что случилось. На 25 июля 2026 `experimental.hook` больше нет ни в
 * справочнике конфигурации OpenCode, ни в опубликованной схеме, а `experimental`
 * в схеме закрыт для чужих ключей. Раздел переведён В ЧТЕНИЕ: панель показывает
 * то, что уже лежит в файле, но ничего туда не пишет (`writeDisabledReason`).
 * Задокументированный способ повесить действие на событие теперь один — плагины.
 */

/**
 * ВТОРАЯ МОДЕЛЬ РАЗДЕЛА (QWEN-1/KIMI-1) — «правила на событие».
 *
 * У Qwen Code и Kimi Code хуки устроены одинаково по смыслу и по-разному по
 * хранилищу: список правил «событие + необязательный матчер + команда оболочки +
 * таймаут». Отсюда общая модель `event-rules` и два формата хранилища:
 *
 *  - `qwen-json` — ключ КОРНЯ `hooks` в `~/.qwen/settings.json` (и в проектном
 *    `<проект>/.qwen/settings.json`): событие → массив групп
 *    `{ matcher, hooks: [ { type: "command", command, timeout } ] }`;
 *  - `kimi-toml` — МАССИВ ТАБЛИЦ `[[hooks]]` в `~/.kimi-code/config.toml`, у
 *    каждой ровно четыре задокументированных поля `event` / `matcher` /
 *    `command` / `timeout`.
 *
 * Единицы таймаута РАЗНЫЕ и это не мелочь: у Qwen — миллисекунды (по умолчанию
 * 60000), у Kimi — секунды (1–600, по умолчанию 30). Поэтому сводка несёт
 * `timeoutUnit` и границы, а интерфейс подписывает поле.
 */

/** Формат хранилища хуков. */
export const providerHooksFormats = ['opencode-json', 'qwen-json', 'kimi-toml'] as const;
export type ProviderHooksFormat = (typeof providerHooksFormats)[number];

/**
 * Форма раздела — по ней интерфейс выбирает редактор:
 *  - `opencode-events` — два события OpenCode с действиями-argv (только чтение);
 *  - `event-rules` — плоский список правил «событие → команда» (Qwen, Kimi).
 *
 * NB: это НЕ `ProviderHooksModel` из `providers.ts` — там речь о том, чей раздел
 * вообще открывать (богатый claude-овский, универсальный или никакого).
 */
export const providerHooksShapes = ['opencode-events', 'event-rules'] as const;
export type ProviderHooksShape = (typeof providerHooksShapes)[number];

/** Единица измерения таймаута правила: у Qwen миллисекунды, у Kimi секунды. */
export const providerHookTimeoutUnits = ['ms', 's'] as const;

/**
 * Одно правило модели `event-rules`: событие, необязательный матчер (регулярное
 * выражение по цели события), команда оболочки и необязательный таймаут.
 */
export const providerHookRuleSchema = object({
  event: string(),
  matcher: string().optional(),
  command: string(),
  timeout: number().optional(),
});

export type ProviderHookRule = Infer<typeof providerHookRuleSchema>;

/** Описание события в сводке: имя и поддерживает ли оно матчер. */
export const providerHookEventInfoSchema = object({
  name: string(),
  supportsMatcher: boolean(),
});

/** Уровень: глобальный конфиг или конфиг проекта. */
export const providerHooksScopes = ['global', 'project'] as const;
export type ProviderHooksScope = (typeof providerHooksScopes)[number];

/** Пара переменной окружения действия. */
export const providerHookEnvVarSchema = object({
  key: string(),
  value: string(),
});

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

/**
 * Сводка раздела хуков провайдера. `readOnly` = true, когда файл не разобран:
 * писать вслепую нельзя (fail-closed), раздел уходит в режим чтения.
 */
export const providerHooksInfoSchema = object({
  providerId: string(),
  providerName: string(),
  format: zodEnum(providerHooksFormats),
  /** Какой редактор открывать: два события OpenCode или список правил. */
  shape: zodEnum(providerHooksShapes).default('opencode-events'),
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
  /** Модель `event-rules`: правила, которыми панель управляет. */
  rules: array(providerHookRuleSchema).default([]),
  /**
   * Модель `event-rules`: события, форму которых панель не поняла (чужие поля,
   * несколько действий в группе, не-командный тип). Такое событие сохраняется
   * целиком и не редактируется; черновик, который его называет, → 422.
   */
  preservedRules: array(providerHookPreservedEntrySchema).default([]),
  /** Модель `event-rules`: задокументированные события этого CLI. */
  events: array(providerHookEventInfoSchema).default([]),
  /** Модель `event-rules`: единица таймаута (у Qwen мс, у Kimi секунды). */
  timeoutUnit: zodEnum(providerHookTimeoutUnits).optional(),
  /**
   * Модель `event-rules`: границы поля таймаута. У Kimi они задокументированы
   * (1–600 с), у Qwen документация даёт только значение по умолчанию — там это
   * потолок самой панели, чтобы в конфиг не уехало бессмысленное число.
   */
  timeoutMin: number().optional(),
  timeoutMax: number().optional(),
  /** Модель `event-rules`: значение таймаута по умолчанию у самого CLI. */
  timeoutDefault: number().optional(),
  /**
   * Qwen: ключ `disableAllHooks` в том же файле. Панель его НЕ пишет (это
   * рубильник всего раздела), но обязана показать: с ним хуки не сработают.
   */
  disableAll: boolean().optional(),
  /** Файл не разобран ЛИБО ключ снят с записи → раздел только для чтения. */
  readOnly: boolean().default(false),
  /** Текст ошибки, если файл не разобран. */
  error: string().optional(),
  /**
   * Ключ исчез из документации и схемы CLI: панель его читает, но больше не
   * пишет. Причина — человеческим языком, её показывает интерфейс. Это НЕ ошибка
   * файла: `error` остаётся пустым, а то, что уже лежит в конфиге, видно.
   */
  writeDisabledReason: string().optional(),
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

/**
 * Тело запроса на запись хуков модели `event-rules` (Qwen, Kimi). Список
 * передаётся ЦЕЛИКОМ: пустой означает «хуков в файле быть не должно» — ключ
 * `hooks` (или регион `[[hooks]]`) удаляется, а не пишется пустым. Событие,
 * форму которого панель не поняла, называть в черновике нельзя: сервер ответит
 * 422 и файл не тронет.
 */
export const providerHookRulesDraftSchema = object({
  rules: array(providerHookRuleSchema),
});

export type ProviderHookRulesDraft = Infer<typeof providerHookRulesDraftSchema>;
