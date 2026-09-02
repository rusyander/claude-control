import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@claude-control/contracts';
import { withoutLiveTurn } from './liveTurn';

/**
 * Ход, который рисует поток, в истории не показывается — иначе перечитка ленты
 * посреди прогона удваивает каждый вызов.
 */
const START = Date.parse('2026-09-02T12:00:00.000Z');

function message(role: ChatMessage['role'], offsetMs: number, id: string): ChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text: id }],
    timestamp: new Date(START + offsetMs).toISOString(),
  };
}

const history = [
  message('user', -60_000, 'old-ask'),
  message('assistant', -50_000, 'old-answer'),
  message('user', 200, 'ask'),
  message('assistant', 3000, 'live-tool'),
  message('assistant', 9000, 'live-text'),
];

describe('withoutLiveTurn', () => {
  it('пока поток на экране, ответы модели после старта скрыты, реплики человека — нет', () => {
    expect(withoutLiveTurn(history, START, true).map((m) => m.id)).toEqual([
      'old-ask',
      'old-answer',
      'ask',
    ]);
  });

  it('потока нет — история целиком, тем же массивом', () => {
    expect(withoutLiveTurn(history, START, false)).toBe(history);
  });

  it('старт неизвестен — прогон до модели не дошёл, скрывать нечего', () => {
    expect(withoutLiveTurn(history, undefined, true)).toBe(history);
  });

  it('ответ, записанный за доли секунды до старта следующего хода, остаётся', () => {
    // Сообщение из очереди уходит сразу за завершением предыдущего: его ответ
    // записан за 50–300 мс до нового старта и обязан остаться на экране.
    const queued = [message('user', -5000, 'ask'), message('assistant', -100, 'answer')];
    expect(withoutLiveTurn(queued, START, true)).toBe(queued);
  });
});
