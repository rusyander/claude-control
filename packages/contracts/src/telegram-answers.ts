import { boolean, number, object, string, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Ответы из Telegram: вопрос панели, который ждёт человека дольше
 * `afterMinutes`, уходит владельцу в личный чат с кнопками, и нажатие решает
 * его тем же маршрутом, что и кнопка в панели.
 *
 * Настройка живёт в своём файле в каталоге данных панели, а не в `state.json`:
 * экспорт настроек уносит `state.json` на другую машину, и включённые там ответы
 * из Telegram на чужой машине стали бы вторым пультом этой. Токен отдельного
 * бота — в зашифрованном хранилище (`int:telegram-answers`), наружу только маска.
 */

/** Сколько минут вопрос ждёт панели, прежде чем уйти в Telegram. 0 — сразу. */
export const TELEGRAM_ANSWERS_MAX_MINUTES = 1440;

export const telegramAnswersSettingsSchema = object({
  enabled: boolean().default(false),
  afterMinutes: number().int().min(0).max(TELEGRAM_ANSWERS_MAX_MINUTES).default(3),
  /**
   * Числовой id владельца в Telegram. Он же — id личного чата с ботом: ответы
   * принимаются только там, где совпали и чат, и отправитель.
   */
  ownerId: string()
    .regex(/^(\d{1,20})?$/)
    .default(''),
});
export type TelegramAnswersSettings = Infer<typeof telegramAnswersSettingsSchema>;

/**
 * Что прислала форма. Токен — только когда его тронули: пустая строка стирает
 * сохранённый, отсутствие поля его не трогает. Форма токена Telegram —
 * `<номер бота>:<ключ>`; иное отсекается сразу, а не после похода в Telegram.
 */
export const telegramAnswersSaveSchema = object({
  enabled: boolean().optional(),
  afterMinutes: number().int().min(0).max(TELEGRAM_ANSWERS_MAX_MINUTES).optional(),
  ownerId: string()
    .trim()
    .regex(/^(\d{1,20})?$/)
    .optional(),
  token: string()
    .trim()
    .max(200)
    .regex(/^(\d{3,20}:[\w-]{20,})?$/)
    .optional(),
});
export type TelegramAnswersSave = Infer<typeof telegramAnswersSaveSchema>;

/**
 * Состояние приёма ответов.
 *
 * - `off` — выключено;
 * - `polling` — панель слушает бота;
 * - `no-token` — нет токена ни у отдельного бота, ни у карточки Telegram;
 * - `owner-missing` — не задан id владельца: принимать ответы не от кого;
 * - `same-bot` — бот панели тот же, что у MCP-сервера Telegram агента: второй
 *   слушатель того же бота отнимал бы у него сообщения, нужен отдельный бот;
 * - `webhook` — у бота стоит вебхук: Telegram не отдаёт обновления опросом, а
 *   снимать чужой вебхук молча панель не вправе;
 * - `conflict` — бота уже слушает кто-то другой (409): опрос остановлен до
 *   сохранения настройки или кнопки «Перезапустить»;
 * - `unauthorized` — Telegram не принял токен;
 * - `error` — сеть или сервис не отвечают, опрос повторяется с паузой.
 */
export const TELEGRAM_ANSWERS_STATES = [
  'off',
  'polling',
  'no-token',
  'owner-missing',
  'same-bot',
  'webhook',
  'conflict',
  'unauthorized',
  'error',
] as const;
export type TelegramAnswersState = (typeof TELEGRAM_ANSWERS_STATES)[number];

export const telegramAnswersStatusSchema = object({
  state: zodEnum(TELEGRAM_ANSWERS_STATES),
  /** Подробность для человека — без токена. */
  detail: string().optional(),
  /** Имя бота, который слушает панель (`@имя`). */
  bot: string().optional(),
  since: string().optional(),
});
export type TelegramAnswersStatus = Infer<typeof telegramAnswersStatusSchema>;

/** То, чем отвечает `GET /api/integrations/telegram/answers`. Токена нет — только маска. */
export interface TelegramAnswersView {
  settings: TelegramAnswersSettings;
  /** Сохранён ли токен отдельного бота. */
  hasToken: boolean;
  maskedToken: string;
  /** Слушать будет бот карточки Telegram: отдельного токена нет, а бот не тот же. */
  usesNotifyBot: boolean;
  /** id владельца не задан, но его можно взять из карточки Telegram (личный чат). */
  suggestedOwnerId?: string;
  status: TelegramAnswersStatus;
  /** Сколько вопросов сейчас ждёт ответа в Telegram. */
  open: number;
}
