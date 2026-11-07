import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '@agentdeck/contracts';
import type { QueuedMessage } from '@shared/lib/agent-runs';

/**
 * Пузырь ушедшего сообщения поверх текущих оптимистичных — ровно один на `sent.id`.
 * Буфер прогона после переподключения отдают заново с нулевого seq: `nextTurn` прошлых ходов
 * приходят ещё раз, и без проверки их пузыри вставали в ленту дублями.
 */
export function withQueuedBubble(
  current: ChatMessage[],
  sent: QueuedMessage,
  timestamp: string,
): ChatMessage[] {
  const id = `pending-queue-${sent.id}`;
  if (current.some((message) => message.id === id)) return current;
  return [
    ...current,
    { id, role: 'user', blocks: [{ type: 'text', text: sent.prompt }], timestamp },
  ];
}

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
    const timestamp = new Date().toISOString();
    setPending((current) => withQueuedBubble(current, sent, timestamp));
  }, [sent, setPending]);
}
