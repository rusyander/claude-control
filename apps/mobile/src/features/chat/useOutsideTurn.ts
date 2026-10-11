import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';

/** Как часто перечитывать ленту хода, идущего вне панели. */
export const OUTSIDE_POLL_MS = 3_000;

/**
 * Ход идёт вне панели — в терминале или VS Code. Потока у телефона нет: шаги
 * видны только через транскрипт, и ленту надо перечитывать самому, иначе она
 * застывает на моменте открытия. Собственный прогон панели главнее: его шаги
 * приходят потоком.
 */
export function useOutsideTurn(
  row: InboxChat | undefined,
  isRunning: boolean,
  transcriptId: string,
): boolean {
  const outside = row?.outside === true && !isRunning;
  const queryClient = useQueryClient();
  const was = useRef(outside);
  useEffect(() => {
    // Ход кончился — опрос встал; последний ответ дочитываем сразу, не ждём
    // устаревания ленты.
    if (was.current && !outside) {
      void queryClient.invalidateQueries({ queryKey: ['chat', transcriptId] });
    }
    was.current = outside;
  }, [outside, queryClient, transcriptId]);
  return outside;
}
