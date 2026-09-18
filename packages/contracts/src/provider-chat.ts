import { object, string, number, boolean, array, enum as zodEnum, type infer as Infer } from 'zod';
import { assistantRunReasons } from './assistant-run.ts';

/**
 * Чат чужого провайдера — своя переписка панели.
 *
 * Claude сюда не входит: у него собственный богатый чат, и он не меняется. У
 * остальных CLI своей читаемой истории нет, поэтому переписку ведёт сама панель
 * — по файлу JSONL на разговор рядом с её состоянием. Это единственные данные,
 * которые панель хранит сама, и причина простая: без них у чужого провайдера не
 * может быть ни списка разговоров, ни продолжения вчерашнего, ни контекста
 * между вопросами.
 *
 * Что панель НЕ выдумывает: структуру ответа. CLI печатает текст — панель
 * показывает текст по мере поступления. Ни шагов, ни вызовов инструментов, ни
 * стоимости здесь нет: чужие CLI их не публикуют, а угадывать формат запрещено.
 */

/**
 * Роль реплики: спросил пользователь, ответил провайдер — или сказала ПАНЕЛЬ.
 *
 * Третья роль появилась с уровнями разделения (Т3 партии чужих CLI): разбор и
 * план могут не дать блока или не завершиться вовсе, и об этом надо сказать в
 * той же ленте, где человек читает ответ. Выдавать такие строки за реплику
 * провайдера нельзя — их писала не модель; в контекст следующего запуска они
 * тоже не идут (`domains/provider-chat/prompt.ts`).
 */
export const providerChatRoles = ['user', 'assistant', 'notice'] as const;

/**
 * Чем именно отработал ответ:
 * - `stream` — CLI запущен на один вопрос, текст показывается по мере печати;
 * - `session` — диалог держит локальный сервер CLI (сейчас только OpenCode);
 * - `api` — прямой вызов модельного API по ключу (CLI не установлен).
 */
export const providerChatTransports = ['stream', 'session', 'api'] as const;
export type ProviderChatTransport = (typeof providerChatTransports)[number];

/** Одна реплика разговора. */
export const providerChatMessageSchema = object({
  id: string(),
  role: zodEnum(providerChatRoles),
  content: string(),
  /** Время записи, ISO-8601. */
  at: string(),
  transport: zodEnum(providerChatTransports).optional(),
  /** Ответ не получен: в реплике текст ошибки, а не ответ модели. */
  failed: boolean().optional(),
  /**
   * Сколько шёл прогон, миллисекунды. Меряет ПАНЕЛЬ по своему процессу, а не
   * парсит вывод CLI: расход в ответе отдают не все и по-разному, а часы есть
   * всегда. Нет поля — разговор записан до этой партии, время не показывается.
   */
  durationMs: number().optional(),
  /**
   * Сколько вызовов инструментов агента насчитал шлюз контура за этот ответ
   * (развилка 5). Чужой CLI вызовы не пишет ни в какой транскрипт, а журнал
   * шлюза видит их на проводе. Ноль — повод подсказать, что модель могла не
   * справиться с инструментами. Нет поля — прогон шёл мимо контура.
   */
  contourToolCalls: number().optional(),
  /**
   * Контур сжал историю хотя бы в одном запросе ЭТОГО прогона. Прогон узнаётся
   * по метке в адресе шлюза, которую панель выдала только ему, — не по окну
   * времени: соседний чат через тот же контур подписи не получит.
   */
  contextSummarized: boolean().optional(),
});
export type ProviderChatMessage = Infer<typeof providerChatMessageSchema>;

/** Разговор в списке: без реплик, но со всем, что нужно строке списка. */
export const providerChatSummarySchema = object({
  id: string(),
  providerId: string(),
  title: string(),
  createdAt: string(),
  updatedAt: string(),
  messageCount: number(),
  /** Рабочий каталог, в котором запускается CLI. Пусто — каталог сервера. */
  workdir: string().optional(),
  /**
   * Модель, подобранная панелью под класс работы при разделении задач (Т12).
   * Помнится РАЗГОВОРОМ, а не прогоном: второе сообщение в тот же чат приходит
   * уже без назначения (телефон и API его не шлют вовсе), и без этой записи оно
   * уехало бы на настройке CLI. Пусто — панель ничего не подбирала.
   */
  model: string().optional(),
  /** Аналог глубины к той же модели; понимает его только Codex. */
  effort: string().optional(),
});
export type ProviderChatSummary = Infer<typeof providerChatSummarySchema>;

/** Разговор целиком. */
export const providerChatDetailSchema = providerChatSummarySchema.extend({
  messages: array(providerChatMessageSchema),
});
export type ProviderChatDetail = Infer<typeof providerChatDetailSchema>;

/** Создание разговора. Название и каталог необязательны. */
export const providerChatCreateRequestSchema = object({
  title: string().optional(),
  workdir: string().optional(),
});
export type ProviderChatCreateRequest = Infer<typeof providerChatCreateRequestSchema>;

/** Правка разговора: переименование и смена рабочего каталога. */
export const providerChatPatchRequestSchema = object({
  title: string().optional(),
  workdir: string().optional(),
});
export type ProviderChatPatchRequest = Infer<typeof providerChatPatchRequestSchema>;

/**
 * Новый вопрос. `attachments` — АБСОЛЮТНЫЕ пути к файлам: панель добавляет их к
 * тексту отдельными строками, потому что агентские CLI читают файлы сами по
 * пути. Содержимое файла в промпт не вкладывается — это был бы формат, которого
 * у чужого CLI нет.
 */
export const providerChatSendRequestSchema = object({
  text: string(),
  attachments: array(string()).optional(),
});
export type ProviderChatSendRequest = Infer<typeof providerChatSendRequestSchema>;

/** Событие потока ответа. */
export const providerChatEventSchema = object({
  type: zodEnum(['delta', 'done', 'error', 'stopped']),
  /** `delta` — очередной кусок текста. */
  text: string().optional(),
  /** `done` — готовая реплика ассистента (она же записана в переписку). */
  message: providerChatMessageSchema.optional(),
  /** `error` — текст для показа и машинная причина. */
  error: string().optional(),
  reason: zodEnum(assistantRunReasons).optional(),
});
export type ProviderChatEvent = Infer<typeof providerChatEventSchema>;

/** Что сейчас происходит с разговором — для восстановления после перезагрузки. */
export const providerChatStatusSchema = object({
  chatId: string(),
  isRunning: boolean(),
  /** Уже напечатанный кусок ответа: по нему вкладка догоняет пропущенное. */
  partial: string(),
  transport: zodEnum(providerChatTransports).optional(),
});
export type ProviderChatStatus = Infer<typeof providerChatStatusSchema>;
