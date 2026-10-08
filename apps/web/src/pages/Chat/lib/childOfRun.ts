import type { ChatSummary } from '@agentdeck/contracts';

/**
 * Ребёнок разделения, которого просят показать по прогону. Ключ прогона группы
 * — временный `new-…`, а разговор в списке — под sessionId: искать только по
 * ключу значило открыть голый поток без шапки группы.
 */
export function childOfRun(
  chats: readonly ChatSummary[] | undefined,
  target: { id: string; sessionId?: string | undefined },
): ChatSummary | undefined {
  return chats?.find(
    (chat) => Boolean(chat.parentId) && (chat.id === target.id || chat.id === target.sessionId),
  );
}
