import type { InboxChat, InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { sentKeys } from './sentKeys';

/** Ожидания чата, которые ещё не отправлены с этого телефона. */
export function visibleAsks(chat: InboxChat, sent: ReadonlySet<string>): InboxAsk[] {
  return chat.asks.filter((ask) => !sentKeys(chat, ask).some((key) => sent.has(key)));
}
