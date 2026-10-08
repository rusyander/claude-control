import type { InboxChat, InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { visibleAsks } from './visibleAsks';

export interface QuestionCardData {
  chat: InboxChat;
  asks: InboxAsk[];
}

/**
 * Карточки вкладки «Вопросы»: по одной на чат. Порядок — кто ждёт дольше,
 * тот выше, и он НЕ меняется от прихода нового вопроса: новый чат встаёт
 * вниз, а не сдвигает карточку, на которую человек сейчас отвечает.
 */
export function questionCards(
  chats: readonly InboxChat[],
  sent: ReadonlySet<string>,
): QuestionCardData[] {
  return chats
    .map((chat) => ({ chat, asks: visibleAsks(chat, sent) }))
    .filter((card) => card.asks.length > 0)
    .sort(
      (a, b) =>
        (a.asks[0]?.askedAt ?? '').localeCompare(b.asks[0]?.askedAt ?? '') ||
        a.chat.id.localeCompare(b.chat.id),
    );
}
