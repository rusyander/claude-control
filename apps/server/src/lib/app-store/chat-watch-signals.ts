import type { GroupWatchRecord } from '@agentdeck/contracts/group-watch';
import type { AppState } from './app-store.types.ts';

/**
 * Срез сигналов сторожа одиночных чатов: ключ чата → блок `{ signals }`. Пишет
 * только сторож; разбирает читатель (`groupSignalsOf`) — блок с диска может быть
 * битым после ручной правки `state.json`.
 */

export function getChatWatchSignals(state: AppState, chatId: string): GroupWatchRecord | undefined {
  const chats = state.chatWatchSignals;
  return chats && Object.hasOwn(chats, chatId) ? chats[chatId] : undefined;
}

/** Все блоки среза: ключ чата → блок. */
export function allChatWatchSignals(state: AppState): Record<string, GroupWatchRecord> {
  return state.chatWatchSignals ?? {};
}

/** Записать блок чата; `undefined` — стереть, пустой срез уходит целиком. */
export function setChatWatchSignals(
  state: AppState,
  chatId: string,
  record: GroupWatchRecord | undefined,
): void {
  const chats = { ...state.chatWatchSignals };
  if (record) chats[chatId] = record;
  else delete chats[chatId];
  if (Object.keys(chats).length > 0) state.chatWatchSignals = chats;
  else delete state.chatWatchSignals;
}
