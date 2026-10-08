import type { ChatMessage } from '@agentdeck/contracts';

/**
 * Последний ход разговора Claude: ответы модели после последней реплики
 * человека. Реплики с одними результатами инструментов в ленту не попадают
 * (`ChatRecords`), поэтому «последняя реплика человека» — действительно его.
 * Нет ответа после неё — хода нет.
 */
export function lastTurnFacts(
  messages: readonly Pick<ChatMessage, 'role' | 'blocks'>[],
): { toolCalls: number; text: string } | undefined {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role === 'assistant') start -= 1;
  const turn = messages.slice(start);
  if (turn.length === 0) return undefined;
  let toolCalls = 0;
  const texts: string[] = [];
  for (const message of turn) {
    for (const block of message.blocks) {
      if (block.type === 'tool') toolCalls += 1;
      if (block.type === 'text') texts.push(block.text);
    }
  }
  // Вызов текстом — это ПОСЛЕДНИЙ текст хода: ранний абзац с примером не должен
  // превращать весь ход в «вызов, который не исполнили».
  return { toolCalls, text: texts.at(-1) ?? '' };
}
