import { object, string, array, boolean, number, literal, union, type infer as Infer } from 'zod';

/**
 * Чат поверх Claude Code. Приложение не хранит переписку само: источник правды —
 * транскрипты самого Claude Code в ~/.claude/projects. Отсюда два следствия:
 * список чатов строится чтением этих файлов, а продолжение разговора идёт
 * через `--resume <sessionId>`, то есть тем же механизмом, что и в терминале.
 */

/** Строка в списке чатов. */
export const chatSummarySchema = object({
  /** Идентификатор сессии Claude Code — он же имя файла транскрипта. */
  id: string(),
  title: string(),
  /** Каталог проекта, в котором шёл разговор. */
  project: string(),
  projectPath: string(),
  /**
   * Разговор заведён в самой панели и живёт в её песочнице. У таких чатов
   * файлы Claude — это артефакты, а у остальных за папкой стоит настоящий
   * проект, и трогать его без разрешения нельзя.
   */
  isSandbox: boolean(),
  messageCount: number(),
  /**
   * Счётчик неполный: у транскрипта больше 4 МБ список читает только начало и
   * хвост файла, поэтому середина в число не попала. Показывать такое число
   * итогом нельзя — интерфейс дорисовывает «+». Полный проход по стомегабайтному
   * файлу ради строки списка стоит секунд, а точный итог там никому не нужен.
   */
  messageCountPartial: boolean().optional(),
  createdAt: string(),
  updatedAt: string(),
  /** Первые слова последнего сообщения — как подзаголовок в списке. */
  preview: string().optional(),
  model: string().optional(),
});

export type ChatSummary = Infer<typeof chatSummarySchema>;

/** Блок внутри сообщения: текст, размышление, вызов инструмента или файл. */
export const chatBlockSchema = union([
  object({ type: literal('text'), text: string() }),
  object({ type: literal('thinking'), text: string() }),
  object({
    type: literal('tool'),
    name: string(),
    input: string(),
    isError: boolean().optional(),
  }),
  object({ type: literal('image'), source: string() }),
]);

export type ChatBlock = Infer<typeof chatBlockSchema>;

export const chatMessageSchema = object({
  id: string(),
  role: union([literal('user'), literal('assistant')]),
  blocks: array(chatBlockSchema),
  timestamp: string(),
  /** Ссылка на предыдущее сообщение — по ней восстанавливается ветка диалога. */
  parentId: string().optional(),
});

export type ChatMessage = Infer<typeof chatMessageSchema>;

/**
 * Страница переписки. Транскрипты бывают огромными, поэтому лента отдаётся
 * окнами: по умолчанию — последние сообщения, а более ранние подгружаются
 * кнопкой «Загрузить ещё». `total` — сколько всего реплик в разговоре,
 * `hasMore` — есть ли ещё более старые сообщения до начала этого окна.
 */
export const chatMessagesPageSchema = object({
  messages: array(chatMessageSchema),
  total: number(),
  hasMore: boolean(),
});

export type ChatMessagesPage = Infer<typeof chatMessagesPageSchema>;

/**
 * Одна реплика в выгрузке разговора. В экспорт идёт только суть — роль, время
 * и текст: размышления, вызовы инструментов и вложения-картинки в файл не
 * тащим, чтобы не выносить наружу служебное и возможные секреты.
 */
export const chatExportEntrySchema = object({
  role: union([literal('user'), literal('assistant')]),
  timestamp: string(),
  text: string(),
});

export type ChatExportEntry = Infer<typeof chatExportEntrySchema>;

/**
 * Совпадение полнотекстового поиска по телу переписки. В отличие от фильтра
 * списка (заголовок/проект/превью), этот поиск сканирует сами сообщения и
 * возвращает разговор с фрагментом вокруг найденного места и числом совпадений.
 */
export const chatSearchHitSchema = object({
  /** Идентификатор сессии — он же id разговора в списке, по нему чат и открывается. */
  sessionId: string(),
  /** Каталог проекта (имя папки Claude Code), в котором шёл разговор. */
  project: string(),
  /** Абсолютный путь рабочей папки — как записан в транскрипте. */
  projectPath: string(),
  title: string(),
  /** Фрагмент текста вокруг первого совпадения, с многоточиями по краям. */
  snippet: string(),
  /** Сколько раз запрос встретился в переписке (по всем репликам). */
  matchCount: number(),
  /** Чья реплика дала первый сниппет. */
  role: union([literal('user'), literal('assistant')]),
  /** Время последней активности, ISO — для сортировки и группировки в списке. */
  updatedAt: string(),
});

export type ChatSearchHit = Infer<typeof chatSearchHitSchema>;

export const chatSearchResponseSchema = object({
  /** Нормализованный (обрезанный) запрос — эхом, чтобы клиент сверил актуальность. */
  query: string(),
  hits: array(chatSearchHitSchema),
});

export type ChatSearchResponse = Infer<typeof chatSearchResponseSchema>;

/**
 * Файл, созданный Claude в рабочей папке чата. Тип определяет вид
 * предпросмотра: страница, размеченный текст, документ, картинка или код.
 */
export const artifactSchema = object({
  name: string(),
  path: string(),
  kind: union([
    literal('html'),
    literal('markdown'),
    literal('pdf'),
    literal('image'),
    literal('code'),
    literal('data'),
    literal('other'),
  ]),
  sizeBytes: number(),
  modifiedAt: string(),
  hasSource: boolean(),
});

export type Artifact = Infer<typeof artifactSchema>;

/** Состояние лимитов подписки — CLI сообщает его при каждом запросе. */
export const rateLimitSchema = object({
  status: string(),
  type: string(),
  /** Момент сброса окна, unix-секунды. */
  resetsAt: number(),
});

export type RateLimit = Infer<typeof rateLimitSchema>;
