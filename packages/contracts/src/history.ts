import { object, string, number, boolean, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * История изменений конфигурации — «что менялось со вчера».
 *
 * Панель перед каждой записью кладёт резервную копию файла в
 * claude-control/backups/. Значит копии — это снимки файлов во времени, а по
 * ним восстановима лента правок: для каждой копии видно, какой файл, когда и
 * ЧТО в нём изменилось. Дифф каждой копии считается против ПРЕДЫДУЩЕЙ копии
 * того же файла, а у самой свежей копии — против ТЕКУЩЕГО файла на диске
 * (последняя, ещё не забэкапленная правка).
 *
 * Секреты в ленту не попадают: файл .mcp-secrets.env из истории исключён —
 * его построчный дифф раскрыл бы значения токенов в интерфейсе.
 */

/** Тип строки диффа: добавлена, удалена или не изменилась (контекст). */
export const diffLineKindSchema = zodEnum(['add', 'del', 'ctx']);

export type DiffLineKind = Infer<typeof diffLineKindSchema>;

export const diffLineSchema = object({
  kind: diffLineKindSchema,
  /** Содержимое строки без завершающего перевода строки. */
  text: string(),
  /**
   * Номер ханка (непрерывного блока правок) для строк add/del; у строк
   * контекста (ctx) не задан. По нему интерфейс группирует блоки и предлагает
   * «вернуть только это изменение», а сервер применяет откат выбранного ханка.
   */
  hunk: number().optional(),
});

export type DiffLine = Infer<typeof diffLineSchema>;

/** Запись ленты: одна правка одного файла. */
export const historyEntrySchema = object({
  /** Имя копии — идентификатор для запроса полного диффа (`?name=…`). */
  name: string(),
  /** Целевой файл конфигурации (basename), к которому относится правка. */
  file: string(),
  /**
   * Против чего считался дифф, человекочитаемо: «предыдущая копия»,
   * «текущий файл» или «первая известная версия».
   */
  label: string(),
  /** Когда снята копия (ISO). */
  at: string(),
  /** Сколько строк добавлено относительно базы сравнения. */
  added: number(),
  /** Сколько строк удалено относительно базы сравнения. */
  removed: number(),
});

export type HistoryEntry = Infer<typeof historyEntrySchema>;

/** Лента изменений: последние правки, свежие сверху. */
export const historyResponseSchema = object({
  items: array(historyEntrySchema),
});

export type HistoryResponse = Infer<typeof historyResponseSchema>;

/** Полный построчный дифф одной копии против её базы. */
export const historyDiffSchema = object({
  /** Целевой файл (basename). */
  file: string(),
  /** Против чего сравнивали — то же, что в записи ленты. */
  label: string(),
  /** Время копии (ISO). */
  at: string(),
  /** Строки диффа по порядку. Пусто, когда дифф не показан. */
  lines: array(diffLineSchema),
  added: number(),
  removed: number(),
  /** Дифф не показан: файл слишком большой или бинарный. */
  skipped: boolean(),
  /** Причина, если skipped. */
  reason: string().optional(),
});

export type HistoryDiff = Infer<typeof historyDiffSchema>;

/**
 * Запрос выборочного отката: имя копии и номер ханка из её диффа против
 * текущего файла. Откатывается ровно этот блок — остальной файл не трогается.
 */
export const historyRevertHunkSchema = object({
  /** Имя копии — то же, что в записи ленты (`?name=…`). */
  name: string(),
  /** Индекс ханка в диффе «копия → текущий файл» (нумерация с нуля). */
  hunk: number().int().nonnegative(),
});

export type HistoryRevertHunkRequest = Infer<typeof historyRevertHunkSchema>;

/** Ответ на выборочный откат: куда записали и копия «состояния до». */
export const historyRevertResultSchema = object({
  ok: boolean(),
  /** Путь файла, в который применён откат. */
  restoredTo: string().optional(),
  /** Копия состояния до отката — сам откат тоже обратим. */
  backupPath: string().optional(),
  /** Нужно ли перезапустить Claude Code, чтобы правка вступила в силу. */
  needsRestart: boolean().optional(),
  error: string().optional(),
});

export type HistoryRevertResult = Infer<typeof historyRevertResultSchema>;
