import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '@claude-control/contracts';
import type { QueuedMessage } from '@shared/lib/agent-runs';

/**
 * Ушедшее из очереди сообщение — в ленту сразу, как обычную свою реплику.
 *
 * Пока агент занят, дописанное живёт пузырём-призраком «Уйдёт следующим». В
 * момент досылки очередь его теряет, а транскрипт ещё несколько секунд не
 * знает о новой реплике — и всё это время сообщение отсутствовало в ленте
 * вовсе: только что было, и нет, хотя агент уже над ним работает. Здесь на
 * него ставится тот же оптимистичный пузырь, что и на набранное руками, а
 * снимает его общее правило `keepPending`, как только реплика есть в истории.
 */
export function useQueuedAsPending(
  sent: QueuedMessage | undefined,
  setPending: Dispatch<SetStateAction<ChatMessage[]>>,
): void {
  const seenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sent || sent.id === seenRef.current) return;
    seenRef.current = sent.id;
    setPending((current) => [
      ...current,
      {
        id: `pending-queue-${sent.id}`,
        role: 'user',
        blocks: [{ type: 'text', text: sent.prompt }],
        timestamp: new Date().toISOString(),
      },
    ]);
  }, [sent, setPending]);
}
