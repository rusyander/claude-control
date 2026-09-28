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

/**
 * Живой прогон, который назван адресом (`?id=`), когда разговора с этим id в
 * списке ещё нет: первый ход нового чата идёт прямо сейчас, а запись появится
 * только по его концу. Так открывает чат агент панели — `start_chat` отдаёт
 * странице имя сессии, и без этого страница показывала бы пустой «Новый чат»
 * всё время, пока агент работает.
 */
export function runForUrl<T extends { id: string; sessionId?: string | undefined }>(
  urlId: string | undefined,
  chats: readonly ChatSummary[] | undefined,
  runs: readonly T[],
): T | undefined {
  // Список ещё не пришёл — рано решать: разговор с этим id может в нём быть.
  if (!urlId || !chats) return undefined;
  if (chats.some((chat) => chat.id === urlId)) return undefined;
  return runs.find((run) => run.sessionId === urlId || run.id === urlId);
}
