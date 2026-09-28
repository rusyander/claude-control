import type { ChatMessage } from '@agentdeck/contracts';
import type { StreamedTool } from '../../shared/lib/runs/types';

/**
 * Вызовы живого хода, которых ещё нет в ленте.
 *
 * Чат, открытый посреди чужого хода (ход со стола, 1b), читает транскрипт уже
 * с записанными шагами этого хода — и тот же поток отдаёт их ещё раз с начала:
 * один AskUserQuestion под другим. Панель прячет ответы модели из истории
 * (`pages/Chat/lib/withoutLiveTurn`), но поток телефона приходит без текста уже
 * записанных шагов — спрятанная история унесла бы «Let me ask.» совсем. Поэтому
 * здесь наоборот: из потока убирается вызов, который уже нарисован историей —
 * тот же инструмент с тем же вводом в ответе модели, записанном после старта
 * прогона (серверные часы, как у транскрипта). Каждая запись истории гасит не
 * больше одного вызова потока: два одинаковых вызова в ходе остаются двумя.
 */
export function liveToolsOutsideHistory(
  history: ChatMessage[],
  tools: StreamedTool[],
  startedAt: number | undefined,
): StreamedTool[] {
  if (startedAt === undefined || tools.length === 0) return tools;
  const recorded = new Map<string, number>();
  for (const message of history) {
    if (message.role !== 'assistant' || Date.parse(message.timestamp) < startedAt) continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool') continue;
      const key = `${block.name}\u0000${block.input}`;
      recorded.set(key, (recorded.get(key) ?? 0) + 1);
    }
  }
  if (recorded.size === 0) return tools;
  const kept = tools.filter((tool) => {
    const key = `${tool.name}\u0000${tool.input}`;
    const left = recorded.get(key) ?? 0;
    if (left === 0) return true;
    recorded.set(key, left - 1);
    return false;
  });
  // Тот же массив, когда убирать нечего: лишний рендер ленты ни к чему.
  return kept.length === tools.length ? tools : kept;
}
