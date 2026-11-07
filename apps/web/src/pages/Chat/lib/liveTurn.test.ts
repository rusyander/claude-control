import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
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

  it('история разговора не-Claude CLI из ядра: прошлые ответы остаются, ответ идущего хода скрыт', () => {
    // Сервер ставит ответу время отправки ЕГО хода (`sentAt` вида сеанса ядра, волна 3): ответ
    // прошлого хода раньше старта прогона, ответ идущего — не раньше отправки, то есть старта.
    const core = [
      message('user', -120_000, 'ист-1'),
      message('assistant', -120_000, 'готов-1'),
      message('user', -60_000, 'ист-2'),
      message('assistant', -60_000, 'готов-2'),
      message('user', 40, 'ист-3'),
      message('assistant', 40, 'готов-3'),
    ];
    expect(withoutLiveTurn(core, START, true).map((m) => m.id)).toEqual([
      'ист-1',
      'готов-1',
      'ист-2',
      'готов-2',
      'ист-3',
    ]);
  });
});
