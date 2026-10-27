import { deleteMessage, deleteMessages } from './bot-api.ts';
import { DELETE_WINDOW_MS, type SentLog } from './sent-log.ts';
import type { AnswersStore } from './store.ts';

/**
 * /clear (решение владельца 25.10.2026).
 *
 * Чат с ботом — рабочий стол, а не архив: отвеченное сворачивается в строку
 * итога сразу (`messageText`), а /clear убирает всё, что бот знает. Ограничения Telegram учтены, а не
 * обходятся: удаляется только моложе 48 часов (старше — молча пропускается и
 * забывается), отказ удаления — в журнал и забыть, повтора нет никогда.
 */

export interface CleanupContext {
  token: string;
  store: AnswersStore;
  sentLog: SentLog | undefined;
  now: number;
  log: (message: string) => void;
}

/** Ответ на /clear уходит сам через столько. */
export const CLEAR_REPLY_TTL_MS = 30_000;
/** Предел Telegram на одно `deleteMessages`. */
const BATCH = 100;

/** Удалить созревшее (ответ на /clear): каждое — один раз, отказ в журнал и забыть. */
export async function flushDeletes(context: CleanupContext): Promise<void> {
  const { store, now } = context;
  for (const entry of store.takeDueDeletes(now)) {
    if (now - entry.sentAt >= DELETE_WINDOW_MS) continue;
    const done = await deleteMessage(context.token, entry.chatId, entry.messageId);
    if (!done.ok)
      context.log(`telegram-answers: delete failed (${done.status}): ${done.description}`);
    context.sentLog?.forget(entry.chatId, [entry.messageId], now);
  }
}

/**
 * /clear: всё, что бот знает в чате владельца и что моложе 48 часов, — кроме
 * сообщений, где ещё ждут ответа: они нужны. Пачками по 100; пачка не прошла
 * (старый Bot API, одно сообщение уже удалено) — по одному. Сколько удалено.
 */
export async function clearChat(context: CleanupContext, chatId: string): Promise<number> {
  const { store, now } = context;
  const waiting = new Set(
    store
      .open()
      .filter((message) => message.items.some((item) => item.state === 'open'))
      .map((message) => message.messageId),
  );
  const known = new Map<number, number>();
  for (const entry of context.sentLog?.list(now) ?? []) {
    if (entry.chatId === chatId) known.set(entry.messageId, entry.at);
  }
  for (const message of store.messages()) {
    if (message.chatId === chatId && message.messageId) {
      known.set(message.messageId, Date.parse(message.sentAt));
    }
  }
  const ids = [...known]
    .filter(([id, at]) => !waiting.has(id) && now - at < DELETE_WINDOW_MS)
    .map(([id]) => id);
  const deleted: number[] = [];
  for (let at = 0; at < ids.length; at += BATCH) {
    const batch = ids.slice(at, at + BATCH);
    const done = await deleteMessages(context.token, chatId, batch);
    if (done.ok) {
      deleted.push(...batch);
      continue;
    }
    for (const id of batch) {
      const one = await deleteMessage(context.token, chatId, id);
      if (one.ok) deleted.push(id);
      else context.log(`telegram-answers: delete failed (${one.status}): ${one.description}`);
    }
  }
  context.sentLog?.forget(chatId, ids, now);
  store.dropDeletes(chatId, ids);
  return deleted.length;
}

export function clearReplyText(deleted: number, waiting: number): string {
  const lines = [
    `🧹 Убрал ${deleted} сообщений. Старше 48 часов Telegram удалять не даёт — для полной ` +
      'очистки: меню чата → Очистить историю.',
  ];
  if (waiting > 0) lines.push(`Осталось ждущих: ${waiting}.`);
  return lines.join('\n');
}
