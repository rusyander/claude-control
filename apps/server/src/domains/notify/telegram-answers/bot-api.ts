import { safeDetail, telegramApiBase } from '../telegram-api.ts';
import { htmlToPlain, isParseRefusal } from './html.ts';
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
  let parsed: {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    // Тело не JSON (прокси, страница ошибки) — решает код ответа.
  }
  if (response.ok && parsed.ok !== false)
    return { ok: true, status: response.status, result: parsed.result as T };
  const retryAfter = parsed.parameters?.retry_after;
  return {
    ok: false,
    status: parsed.error_code ?? response.status,
    description: scrub(parsed.description ?? `HTTP ${response.status}`),
    ...(typeof retryAfter === 'number' && retryAfter >= 0 ? { retryAfter } : {}),
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

/** Дольше этого Telegram не ждём: просьба подождать минуты — сбой, а не очередь. */
export const MAX_RETRY_AFTER_S = 120;
const MAX_ATTEMPTS = 3;

export interface HtmlCallOptions {
  /** Пауза перед повтором после 429; подменяется в тестах. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Очередь отправок в один чат: пока одна отправка ждёт `retry_after`, следующая
 * в тот же чат не обгоняет её и не получает свой 429 зря. Разные чаты не ждут
 * друг друга.
 */
const chatQueues = new Map<string, Promise<unknown>>();

function inChatQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const tail = chatQueues.get(key) ?? Promise.resolve();
  const next = tail.then(work, work);
  const settled = next.catch(() => undefined);
  chatQueues.set(key, settled);
  void settled.then(() => {
    if (chatQueues.get(key) === settled) chatQueues.delete(key);
  });
  return next;
}

/**
 * Вызов с текстом разметки HTML. Telegram не разобрал разметку (400 «can't parse
 * entities») — тот же вызов простым текстом: сообщение важнее оформления.
 * 429 — ждём, сколько Telegram просит (до 120 с), и повторяем, до трёх попыток;
 * просит дольше — отказ сразу: повтор через две минуты встретил бы тот же 429.
 */
export function callHtml<T>(
  token: string,
  method: string,
  html: string,
  rest: Record<string, unknown>,
  options: HtmlCallOptions = {},
): Promise<BotCall<T>> {
  const key = `${botIdOf(token) ?? ''}:${String(rest.chat_id ?? '')}`;
  return inChatQueue(key, async () => {
    let result = await callHtmlOnce<T>(token, method, html, rest);
    for (
      let attempt = 1;
      attempt < MAX_ATTEMPTS && !result.ok && result.status === 429;
      attempt++
    ) {
      const seconds = Math.max(result.retryAfter ?? 1, 0);
      if (seconds > MAX_RETRY_AFTER_S) break;
      await (options.sleep ?? wait)(seconds * 1_000);
      result = await callHtmlOnce<T>(token, method, html, rest);
    }
    return result;
  });
}

async function callHtmlOnce<T>(
  token: string,
  method: string,
  html: string,
  rest: Record<string, unknown>,
): Promise<BotCall<T>> {
  const first = await callBot<T>(token, method, { ...rest, text: html, parse_mode: 'HTML' });
  if (first.ok || !isParseRefusal(first.status, first.description)) return first;
  return callBot<T>(token, method, { ...rest, text: htmlToPlain(html) });
}

/** Сообщение разметкой HTML: динамическое в `text` уже экранировано (`compose.ts`). */
export const sendMessage = (
  token: string,
  chatId: string,
  text: string,
  markup?: ReplyMarkup,
  replyTo?: number,
) =>
  callHtml<SentBotMessage>(token, 'sendMessage', text, {
    chat_id: chatId,
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
  callHtml<unknown>(token, 'editMessageText', text, {
    chat_id: chatId,
    message_id: messageId,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });

/** Меню команд бота; `language` — для пользователей с этим языком Telegram. */
export const setMyCommands = (
  token: string,
  commands: readonly { command: string; description: string }[],
  language?: string,
) =>
  callBot<unknown>(token, 'setMyCommands', {
    commands,
    ...(language ? { language_code: language } : {}),
  });

/** Удалить одно сообщение. Telegram удаляет только моложе 48 часов. */
export const deleteMessage = (token: string, chatId: string, messageId: number) =>
  callBot<boolean>(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });

/** Удалить до 100 сообщений одного чата разом. */
export const deleteMessages = (token: string, chatId: string, messageIds: readonly number[]) =>
  callBot<boolean>(token, 'deleteMessages', { chat_id: chatId, message_ids: messageIds });

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
