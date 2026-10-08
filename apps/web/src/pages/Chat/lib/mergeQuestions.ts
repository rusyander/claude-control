import type { ChildQuestion } from '@features/ChatMessages';

/**
 * Склейка с тем, что вкладка видит в живом потоке: один и тот же вопрос у
 * подключённого прогона приходит обоими путями. Совпадение — по id вызова, у
 * вопроса текстом — по разговору (он у разговора один, последний).
 */
export function mergeQuestions(live: ChildQuestion[], server: ChildQuestion[]): ChildQuestion[] {
  const out = [...live];
  for (const item of server) {
    const dup = item.toolUseId
      ? live.some((other) => other.toolUseId === item.toolUseId)
      : live.some((other) => other.chatId === item.chatId && other.text === item.text);
    if (!dup) out.push(item);
  }
  return out;
}
