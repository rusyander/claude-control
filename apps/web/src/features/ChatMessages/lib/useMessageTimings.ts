import { useMemo } from 'react';
import type { ChatMessage } from '@agentdeck/contracts';
import { collectMessageTimings, type MessageTiming } from '@agentdeck/contracts/chat-timing';

/**
 * Время шагов ленты — по соседним записям, один проход на всю историю.
 * Идущий прогон не закрыт: его хвост ещё пишется, и суммы у него нет.
 */
export function useMessageTimings(
  messages: ChatMessage[],
  isRunning: boolean | undefined,
): Map<string, MessageTiming> {
  return useMemo(
    () => collectMessageTimings(messages, { openRun: Boolean(isRunning) }),
    [messages, isRunning],
  );
}
