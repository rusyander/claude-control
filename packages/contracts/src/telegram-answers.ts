import {
  boolean,
  number,
  object,
  string,
  enum as zodEnum,
  type infer as Infer,
  type input,
} from 'zod';

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
  /**
   * Как владелец назвался при подключении по /start: «Анна (@anna)». Только для
   * карточки («Кому пишет»); id сменили руками — имя стирается, чужим оно не станет.
   */
  ownerName: string().max(200).default(''),
});
export type TelegramAnswersSettings = Infer<typeof telegramAnswersSettingsSchema>;
/** То же до умолчаний: поля, которых нет, схема дополнит. */
export type TelegramAnswersSettingsInput = input<typeof telegramAnswersSettingsSchema>;

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

/**
 * Подключение бота командой /start: панель на пять минут открывает окно и ждёт
 * `/start` в личном чате с ботом. Пришедший — только кандидат: id в настройки
 * ложится после того, как человек в панели подтвердит «это я».
 *
 * - `idle` — окно не открыто;
 * - `waiting` — ждём `/start` до `expiresAt`;
 * - `candidate` — пришёл `/start`, ждёт подтверждения в панели;
 * - `expired` — пять минут прошли без `/start`;
 * - `confirmed` — подтверждено: чат уведомлений и владелец ответов записаны;
 * - `failed` — окно не открылось или опрос оборвался (`reason`).
 */
export const TELEGRAM_CONNECT_STATES = [
  'idle',
  'waiting',
  'candidate',
  'expired',
  'confirmed',
  'failed',
] as const;
export type TelegramConnectState = (typeof TELEGRAM_CONNECT_STATES)[number];

/**
 * Почему окно не открылось:
 * - `no-token` — в карточке Telegram нет токена бота;
 * - `same-bot` — этого бота слушает агент (MCP или канал): второй слушатель
 *   отнимал бы у него сообщения;
 * - `unauthorized` — Telegram не принял токен;
 * - `webhook` — у бота стоит вебхук, опрос невозможен;
 * - `conflict` — бота уже слушает кто-то другой (409);
 * - `network` — сеть или сервис не ответили.
 */
export const TELEGRAM_CONNECT_REASONS = [
  'no-token',
  'same-bot',
  'unauthorized',
  'webhook',
  'conflict',
  'network',
] as const;
export type TelegramConnectReason = (typeof TELEGRAM_CONNECT_REASONS)[number];

/** Кто прислал `/start`: имя, ник и числовой id (он же id личного чата). */
export interface TelegramConnectCandidate {
  id: string;
  firstName: string;
  username?: string;
}

/** Ответ маршрутов `/api/integrations/telegram/connect*`. */
export interface TelegramConnectView {
  state: TelegramConnectState;
  /** Ник бота без `@`. */
  bot?: string;
  /** `https://t.me/<бот>` — куда человеку нажать «Start». */
  link?: string;
  expiresAt?: string;
  candidate?: TelegramConnectCandidate;
  reason?: TelegramConnectReason;
  /** Подробность Telegram — без токена. */
  detail?: string;
}

/**
 * Цель ожидания «вопрос ядра задач» (этап 12, D29, P188): сообщение бота несёт вопрос ядра и
 * `cmdId` каждой команды выбора — повтор нажатия шлёт те же ключи повтора, второй строки в журнале
 * нет (P189). Объединение целей сервера (`AskTarget`) расширяет зона ответов Telegram.
 */
export interface TelegramCoreAskTarget {
  kind: 'coreAsk';
  taskId: string;
  askId: string;
  cmdIds: string[];
}
