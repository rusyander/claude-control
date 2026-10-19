import { useState } from 'react';
import { CHAT_PAGE_SIZE } from '@entities/Chat';
import { recallFeedLimit, rememberFeedLimit } from '@features/ChatMessages';

/**
 * Размер окна ленты разговора. Растёт кнопкой «Загрузить ещё»: каждый шаг
 * подтягивает более ранние сообщения. Новый разговор — последнее окно, а
 * разговор, в котором человек отлистал место и вернулся, — то окно, где это
 * место есть (иначе лента не нашла бы, куда вернуть прокрутку).
 *
 * Смена разговора пересчитывает окно в том же рендере, а не эффектом: эффект
 * давал один рендер со старым окном под новым id — лишний запрос, и лента
 * успевала встать по нему.
 */
export function useMessagesLimit(chatId: string | undefined) {
  const initial = (id: string | undefined) => ({
    chatId: id,
    limit: recallFeedLimit(id) ?? CHAT_PAGE_SIZE,
  });
  const [state, setState] = useState(() => initial(chatId));
  let current = state;
  if (state.chatId !== chatId) {
    current = initial(chatId);
    setState(current);
  }

  return {
    limit: current.limit,
    loadMore: (): void => {
      const next = current.limit + CHAT_PAGE_SIZE;
      setState({ chatId, limit: next });
      rememberFeedLimit(chatId, next);
    },
  };
}
