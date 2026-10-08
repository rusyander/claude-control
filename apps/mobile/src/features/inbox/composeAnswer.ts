import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { CardState } from './queue.types';

/**
 * Ответ на вопросы одного вызова `AskUserQuestion` — одним текстом, как у
 * панели (`composeAnswer` окна чата): один вопрос — просто выбранное, несколько
 * — строкой «заголовок: выбранное» на вопрос.
 */
export function composeAnswer(
  asks: readonly Extract<InboxAsk, { kind: 'question' }>[],
  answers: CardState['answers'],
): string {
  const picked = asks.map((ask) => {
    const answer = answers[ask.key];
    return answer?.kind === 'question' ? answer.labels : [];
  });
  if (asks.length === 1) return (picked[0] ?? []).join(', ');
  return asks
    .map((ask, at) => {
      const chosen = picked[at] ?? [];
      if (chosen.length === 0) return '';
      const title = ask.question.header || ask.question.question || String(ask.index + 1);
      return `${title}: ${chosen.join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
}
