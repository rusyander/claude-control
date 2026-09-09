import { useEffect, useLayoutEffect, useRef } from 'react';
import type { FeedScrollSignals } from './useFeedScroll.types';

/**
 * Прокрутка ленты: держаться низа, пока человек внизу, и не прыгать при
 * подгрузке более ранних сообщений.
 *
 * Пока пользователь внизу — лента едет за ответом; стоит ему отлистать вверх,
 * чтобы перечитать, — отпускаем (раньше лента тянула вниз на каждом слове, и
 * читать прошлое во время ответа было нельзя). Подгруженные сверху сообщения
 * сдвигают содержимое вниз — позицию восстанавливаем по приросту высоты.
 */
export function useFeedScroll({
  conversationId,
  messageCount,
  streamText,
  streamToolCount,
  stalled,
  permissionCount,
}: FeedScrollSignals) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isPinned = useRef(true);
  // Высота ленты в момент клика «Загрузить ещё»; есть — идёт восстановление.
  const restoreScroll = useRef<number | undefined>(undefined);

  // Смена разговора — снова к последнему сообщению. Ключ — id разговора, а не
  // первого сообщения: при подгрузке более ранних первое сообщение меняется, но
  // прокрутку к низу это запускать не должно.
  useEffect(() => {
    isPinned.current = true;
    restoreScroll.current = undefined;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId]);

  useEffect(() => {
    // Подгрузка более ранних не должна утягивать ленту вниз — её обрабатывает
    // отдельный layout-эффект восстановления позиции.
    if (restoreScroll.current !== undefined) return;
    if (isPinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messageCount, streamText, streamToolCount, stalled, permissionCount]);

  // Восстановление позиции после подгрузки более ранних: держим на экране то же
  // сообщение, что и было, компенсируя прокрутку приростом высоты сверху.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || restoreScroll.current === undefined) return;
    list.scrollTop += list.scrollHeight - restoreScroll.current;
    restoreScroll.current = undefined;
  }, [messageCount]);

  return {
    bottomRef,
    listRef,
    /** Запомнить высоту перед «Загрузить ещё» — после прибавки позиция вернётся. */
    rememberHeight: () => {
      if (listRef.current) restoreScroll.current = listRef.current.scrollHeight;
    },
    /** Прокрутка человека: у низа — снова держимся, отлистал — отпускаем. */
    onScroll: (list: HTMLDivElement) => {
      isPinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
    },
  };
}
