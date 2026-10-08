import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatRowData } from '../ui/ChatList/ChatList.types';

/**
 * Совпадения по телу приходят глобально; показываем из них только те, что есть
 * в видимом списке (он уже ограничен вкладкой), и переносим на строки сниппет с
 * числом совпадений. Порядок — от свежего к старому, как и в обычном списке.
 */
export function matchBodyHits(
  chats: ChatSummary[],
  hits: { sessionId: string; snippet: string; matchCount: number }[] | undefined,
): ChatRowData[] {
  if (!hits || hits.length === 0) return [];

  const bySession = new Map(hits.map((hit) => [hit.sessionId, hit]));

  return chats
    .filter((chat) => bySession.has(chat.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((chat) => {
      const hit = bySession.get(chat.id);
      return { chat, snippet: hit?.snippet, matchCount: hit?.matchCount };
    });
}
