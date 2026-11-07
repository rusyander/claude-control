import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { withQueuedBubble } from './useQueuedAsPending';

/**
 * core-chat-012: слово «на ходу» чата на ядре встаёт в ленту пузырём по `nextTurn`. Повтор буфера
 * прогона с нулевого seq приносит прошлые `nextTurn` ещё раз — пузырь каждого слова один.
 */
describe('withQueuedBubble', () => {
  const at = '2026-11-06T10:00:00.000Z';

  it('ушедшее слово встаёт пузырём человека с его текстом', () => {
    expect(withQueuedBubble([], { id: 'turn-5000', prompt: 'ход-42' }, at)).toEqual([
      {
        id: 'pending-queue-turn-5000',
        role: 'user',
        blocks: [{ type: 'text', text: 'ход-42' }],
        timestamp: at,
      },
    ]);
  });

  it('повтор буфера (A, B, затем снова A) — пузырей два, без дубля', () => {
    let bubbles: ChatMessage[] = [];
    for (const sent of [
      { id: 'turn-5000', prompt: 'ход-42' },
      { id: 'turn-7000', prompt: 'ход-44' },
      { id: 'turn-5000', prompt: 'ход-42' },
    ]) {
      bubbles = withQueuedBubble(bubbles, sent, at);
    }
    expect(bubbles.map((bubble) => bubble.id)).toEqual([
      'pending-queue-turn-5000',
      'pending-queue-turn-7000',
    ]);
  });
});
