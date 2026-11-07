import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';

/** Что лента видела в прошлый раз: разговор и границу его живого хода. */
interface SeenTurn {
  chatId: string | undefined;
  turnAt: number | undefined;
}

/**
 * Перечитать переписку на границе хода внутри прогона (`turnAt`, событие `nextTurn`).
 *
 * Чат на ядре ведёт слово «на ходу» новым ходом ТОГО ЖЕ прогона: пузырь потока на границе
 * очищается и рисует новый ход, а ответ прошлого хода лента берёт уже из истории. Пока прогон
 * идёт, историю никто не перечитывает (`useChatAutoRefresh` бережёт её до конца прогона), и
 * прошлый ответ пропадал с экрана до конца прогона (F-02). Новая граница — тот же повод, что
 * конец хода у телефона (`useTurnEndRefresh`). Смена разговора поводом не считается: открытый
 * чат читает свою ленту сам.
 */
export function useTurnBoundaryRefresh(
  chatId: string | undefined,
  turnAt: number | undefined,
): void {
  const queryClient = useQueryClient();
  const seen = useRef<SeenTurn>({ chatId, turnAt });
  useEffect(() => {
    const before = seen.current;
    seen.current = { chatId, turnAt };
    if (!chatId || before.chatId !== chatId) return;
    if (turnAt === undefined || turnAt === before.turnAt) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
  }, [chatId, turnAt, queryClient]);
}
