import { z } from 'zod';
import { uuidv7 } from './ids.ts';

/**
 * Пересылка вопросов ядра людям (этап 10, Q9): её ведёт сервер панели — секреты каналов живут
 * там, ядро каналов не знает. Канал только СООБЩАЕТ и даёт ссылку: ответ `answer` — суд
 * `human-strict` (`policy/authority`), Telegram ответить не может, только панель или телефон.
 */

export const RELAY_CHANNELS = ['phone', 'telegram'] as const;
export type RelayChannel = (typeof RELAY_CHANNELS)[number];

/**
 * Пересылка сообщает только о том, что ждёт человека (этап 12, m3): вопрос ядра. Итог задачи
 * (`report-final`) убран — телефон и Telegram не звонят о готовом, его видно на доске.
 */
export const relayNoticeSchema = z.strictObject({
  taskId: uuidv7,
  askId: uuidv7,
  kind: z.enum(['ask']),
  title: z.string().min(1).max(500),
  /** Ссылка панели на эту задачу (`/core?id=…&ask=…`): ответ — только там или с телефона. */
  deepLink: z.string().min(1),
});
export type RelayNotice = z.infer<typeof relayNoticeSchema>;

/** Курсор пересылки: задача → последний `Last-Event-ID` SSE ядра (`<дом панели>/core-relay.json`). */
export const relayCursorSchema = z.record(uuidv7, z.string().min(1));
export type RelayCursor = z.infer<typeof relayCursorSchema>;

/** Сколько отправленных вопросов помнит пересылка: старше — задачи давно кончились. */
export const RELAY_DELIVERED_MAX = 2000;

/**
 * Файл пересылки целиком: курсор (с какой строки читать поток после перезапуска панели) и
 * вопросы, о которых уже сообщено (`askId`). Курсор один не делает «ровно раз»: панель, упавшая
 * между отправкой и записью курсора, прочла бы строку вопроса снова — второго сообщения не даёт
 * список отправленных.
 */
/** Сколько ждущих канала вопросов помнит пересылка. */
export const RELAY_PENDING_MAX = 200;

/**
 * Вопрос, о котором сообщить пока некуда (ни push, ни Telegram не настроены или канал упал):
 * курсор уже за его строкой, поэтому он ждёт здесь и уходит, как только канал появился.
 */
export const relayPendingSchema = z.strictObject({
  taskId: uuidv7,
  askId: uuidv7,
  question: z.string(),
  /**
   * Вопрос блокирует (`askWaits`, этап 12, P175): только такой звонит на телефон. Нет поля — запись
   * до этапа 12, когда push шёл о каждом вопросе: считается блокирующим.
   */
  waits: z.boolean().optional(),
});
export type RelayPending = z.infer<typeof relayPendingSchema>;

export const relayStateSchema = z.strictObject({
  cursors: relayCursorSchema,
  delivered: z.array(uuidv7).max(RELAY_DELIVERED_MAX),
  /** Файл до появления поля — без ждущих. */
  pending: z.array(relayPendingSchema).max(RELAY_PENDING_MAX).default([]),
});
export type RelayState = z.infer<typeof relayStateSchema>;
