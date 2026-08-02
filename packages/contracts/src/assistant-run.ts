import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';
import { runnerModes } from './provider-keys';

/**
 * Реальный запуск ассистента активного провайдера (Ф6b).
 *
 * Мультимодельный раннер: по режиму активного провайдера (`cli`/`api`/`none`)
 * панель либо запускает CLI провайдера в one-shot-режиме (basic, не stream-json),
 * либо ходит напрямую в модельный API по ключу, либо отказывает со структурной
 * причиной (для модалки-инструкции). Claude идёт СВОИМ существующим путём —
 * этот роут его богатый стриминговый чат НЕ заменяет.
 *
 * БЕЗОПАСНОСТЬ: ключи/секреты в ответ и логи не попадают. Промпт CLI передаётся
 * argv-массивом (без интерполяции в shell).
 */

/** Роль реплики в мультимодельном чате (пользователь / ассистент). */
export const assistantRunRoles = ['user', 'assistant'] as const;

/** Одна реплика диалога (простой текст — basic-режим). */
export const assistantRunMessageSchema = object({
  role: zodEnum(assistantRunRoles),
  content: string(),
});

/**
 * Тело `POST /api/assistant/run`: история сообщений (последнее — новый запрос).
 *
 * `conversationId` — устойчивый идентификатор ОДНОГО диалога панели. Нужен
 * ровно одному раннеру: сессионному режиму OpenCode (`opencode serve`), где
 * контекст держит сам CLI, а панель шлёт только новое сообщение. Прочие раннеры
 * его игнорируют: у one-shot CLI памяти между вызовами нет по построению, и вся
 * история по-прежнему уезжает одним промптом.
 */
export const assistantRunRequestSchema = object({
  messages: array(assistantRunMessageSchema),
  conversationId: string().optional(),
});
export type AssistantRunRequest = Infer<typeof assistantRunRequestSchema>;

/**
 * Причина итога запуска (машиночитаемая, для i18n):
 * - `ok` — ответ получен;
 * - `no_key_no_cli` / `unsupported` — раннер `none` (нужна подписка или ключ);
 * - `cli_not_scriptable` — CLI есть, но one-shot-флаг для него не задокументирован;
 * - `cli_error` — CLI завершился ошибкой/пустым выводом/таймаутом;
 * - `api_error` — модельный API вернул ошибку.
 */
export const assistantRunReasons = [
  'ok',
  'no_key_no_cli',
  'unsupported',
  'cli_not_scriptable',
  'cli_error',
  'api_error',
] as const;
export type AssistantRunReason = (typeof assistantRunReasons)[number];

/** Ответ `POST /api/assistant/run`: текст ответа + метаданные раннера. */
export const assistantRunResultSchema = object({
  ok: boolean(),
  providerId: string(),
  /** Режим, которым отработали (`cli`/`api`/`none`). */
  mode: zodEnum(runnerModes),
  /** Текст ответа модели (пусто при ошибке/none). */
  reply: string(),
  /** Basic-режим (CLI one-shot, не богатый stream-json) — помечаем экспериментальным. */
  experimental: boolean(),
  reason: zodEnum(assistantRunReasons),
  /** Текст ошибки для показа (без секретов), если `ok=false`. */
  error: string().optional(),
  /**
   * Как именно отработал CLI-раннер:
   * - `one-shot` — отдельный процесс на каждый вопрос, памяти между вызовами нет
   *   (вся история уезжает одним промптом);
   * - `session` — локальный сервер CLI держит диалог, панель шлёт только новое
   *   сообщение. Сейчас так умеет ровно OpenCode (`opencode serve`).
   * Не задано — режим `api`/`none`, к которому это понятие не относится.
   */
  transport: zodEnum(['one-shot', 'session']).optional(),
  /** Идентификатор сессии CLI, если диалог идёт сессией (для показа и отладки). */
  sessionId: string().optional(),
});
export type AssistantRunResult = Infer<typeof assistantRunResultSchema>;
