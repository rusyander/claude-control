import type { ChatSummary } from '@agentdeck/contracts';

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
