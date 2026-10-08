import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { visibleAsks } from './visibleAsks';

/** Сколько всего ждёт ответа — число на вкладке. */
export function pendingCount(chats: readonly InboxChat[], sent: ReadonlySet<string>): number {
  return chats.reduce((sum, chat) => sum + visibleAsks(chat, sent).length, 0);
}
