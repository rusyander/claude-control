import type { ChatSummary } from '@agentdeck/contracts';

/**
 * Каким разговором стал вид живого прогона. Черновик человека становится
 * разговором по концу первого хода — до того его записи в списке честно нет.
 * Группа разделения — другое дело: её разговор заводит конвейер, он уже в
 * списке, и ждать конца хода значило бы весь ход показывать в шапке модель,
 * усилие и «До MR» проекта вместо назначенных группе (живой прогон 25.09.2026).
 */
export function runViewChat(
  chats: readonly ChatSummary[] | undefined,
  sessionId: string | undefined,
  isRunning: boolean,
): ChatSummary | undefined {
  if (!sessionId) return undefined;
  const found = chats?.find((chat) => chat.id === sessionId);
  if (!found) return undefined;
  if (isRunning && !found.parentId) return undefined;
  return found;
}

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
