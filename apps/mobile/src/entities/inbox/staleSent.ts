import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { sentKeys } from './sentKeys';

/**
 * Ключи отправленного, которых сервер больше не отдаёт: ответ дошёл, память о
 * нём не нужна. Пока сервер ещё отдаёт тот же вопрос (опрос не успел), ключ
 * держит карточку скрытой — иначе она мигнула бы обратно.
 */
export function staleSent(chats: readonly InboxChat[], sent: ReadonlySet<string>): string[] {
  const live = new Set(chats.flatMap((chat) => chat.asks.flatMap((ask) => sentKeys(chat, ask))));
  return [...sent].filter((key) => !live.has(key));
}
