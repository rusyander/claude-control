import type { ChatMessage } from '@agentdeck/contracts';

/**
 * Агент закончил хотя бы один шаг после `since`, а хук панели так и не
 * отозвался — значит, сессия запущена без хуков и сообщение само не дойдёт.
 *
 * Шаг закончен, когда за ответом с вызовом инструмента идёт следующий ответ
 * модели: тот вызов отработал, и PostToolUse, будь он установлен, уже
 * сработал. До первого такого шага молчание хука ничего не значит —
 * предупреждать в свежей сессии, пока идёт её первый инструмент, значит пугать
 * зря.
 */
export function stepFinishedSince(messages: ChatMessage[], since: string): boolean {
  const from = Date.parse(since);
  let toolCalled = false;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (toolCalled && Date.parse(message.timestamp) > from) return true;
    if (message.blocks.some((block) => block.type === 'tool')) toolCalled = true;
  }
  return false;
}
