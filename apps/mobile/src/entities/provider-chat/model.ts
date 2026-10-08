import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';

/**
 * Разговор с чужим CLI (Codex, Qwen Code…) на телефоне — чистая часть: куда
 * ведёт уведомление и что сделает кнопка отправки. Без React и без сети, чтобы
 * проверяться тестом, а не глазами на устройстве.
 */

/** Куда открыть приложение по нажатию на уведомление. */
export type NotificationTarget =
  | { kind: 'foreign'; providerId: string; chatId: string }
  | { kind: 'claude'; chatId: string; projectPath: string };

/**
 * Данные уведомления → экран. Сервер кладёт в `chatId` ключ разговора: у чужого
 * CLI он с приставкой (`codex:<id>`), у Claude — сессия как есть. Пусто или не
 * строка (проверочное уведомление, чужая программа) — никуда не ведём.
 */
export function notificationTarget(data: unknown): NotificationTarget | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : '';
  if (!chatId) return undefined;
  const foreign = parseForeignChatKey(chatId);
  if (foreign) return { kind: 'foreign', ...foreign };
  // Ключ с двоеточием, который не разобрался в чужой (`claude:…`), — не сессия Claude.
  if (chatId.includes(':')) return undefined;
  const projectPath = typeof record.projectPath === 'string' ? record.projectPath : '';
  return { kind: 'claude', chatId, projectPath };
}
