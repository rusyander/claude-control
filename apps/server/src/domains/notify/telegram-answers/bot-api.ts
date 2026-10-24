import { safeDetail, telegramApiBase } from '../telegram.ts';
import type {
  BotCall,
  BotUpdate,
  InlineKeyboard,
  ReplyMarkup,
  SentBotMessage,
} from './telegram-answers.types.ts';

/**
 * Bot API для ответов из Telegram: опрос обновлений, сообщение с кнопками,
 * правка сообщения, ответ на нажатие.
 *
 * Свой клиент, а не общий `sendRequest`: у того 15 с на запрос, а длинный опрос
 * `getUpdates` по замыслу держит соединение до 50 с. И отказ здесь — значение,
 * а не исключение: опросу нужен код ответа (409 — бота слушает другой, 401 —
 * токен не принят), а не текст для человека.
 *
 * ТОКЕН — ЧАСТЬ АДРЕСА. Ни в одну подробность, журнал или ответ API он не
 * попадает: подробность проходит `safeDetail`, а адрес в текст не пишется вовсе.
 */

/** Сколько ждём обычный вызов (отправка, правка). */
const CALL_TIMEOUT_MS = 15_000;

/** Подробность без токена: и в форме `bot<id>:<ключ>`, и голым значением. */
export function scrub(text: string): string {
  return safeDetail(text).replace(/\d{6,20}:[\w-]{20,}/g, '<токен>');
}

export async function callBot<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BotCall<T>> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  let response: Response;
  try {
    response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const aborted = options.signal?.aborted === true;
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, aborted, description: scrub(text) };
  }
  let parsed: { ok?: boolean; result?: T; description?: string; error_code?: number } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    // Тело не JSON (прокси, страница ошибки) — решает код ответа.
  }
  if (response.ok && parsed.ok !== false)
    return { ok: true, status: response.status, result: parsed.result as T };
  return {
    ok: false,
    status: parsed.error_code ?? response.status,
    description: scrub(parsed.description ?? `HTTP ${response.status}`),
  };
}

export const getMe = (token: string) =>
  callBot<{ id: number; username?: string; first_name?: string }>(token, 'getMe');

export const getWebhookInfo = (token: string) =>
  callBot<{ url?: string; pending_update_count?: number }>(token, 'getWebhookInfo');

/** Длинный опрос: Telegram держит ответ до `timeout` с, пока обновлений нет. */
export const getUpdates = (token: string, offset: number, timeout: number, signal?: AbortSignal) =>
  callBot<BotUpdate[]>(
    token,
    'getUpdates',
    { offset, timeout, allowed_updates: ['callback_query', 'message'] },
    { timeoutMs: (timeout + 15) * 1000, ...(signal ? { signal } : {}) },
  );

export const sendMessage = (
  token: string,
  chatId: string,
  text: string,
  markup?: ReplyMarkup,
  replyTo?: number,
) =>
  callBot<SentBotMessage>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(markup ? { reply_markup: markup } : {}),
    ...(replyTo
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}),
  });

/** Правка текста; кнопки, которых нет в `keyboard`, снимаются. */
export const editMessageText = (
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard,
) =>
  callBot<unknown>(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });

export const answerCallbackQuery = (token: string, id: string, text?: string) =>
  callBot<unknown>(token, 'answerCallbackQuery', {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });

/** Номер бота — часть токена до двоеточия; сам токен не нужен, чтобы сравнить ботов. */
export function botIdOf(token: string | undefined): string | undefined {
  const match = /^(\d{3,20}):/.exec(token?.trim() ?? '');
  return match?.[1];
}
