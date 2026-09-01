import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@claude-control/contracts';
import { keepPending } from './pending';

/**
 * Дублирование реплик в ленте, о котором сообщил владелец 1 сентября: свои
 * сообщения показывались внизу по два-три раза, хотя ничего не переотправлялось
 * и в самом транскрипте дублей не было. Каждый стенд ниже — способ, которым
 * пузырь оставался в ленте навсегда.
 */

function bubble(text: string, timestamp: string): ChatMessage {
  return { id: `pending-${timestamp}`, role: 'user', blocks: [{ type: 'text', text }], timestamp };
}

function entry(role: 'user' | 'assistant', text: string, timestamp: string): ChatMessage {
  return { id: `m-${timestamp}`, role, blocks: [{ type: 'text', text }], timestamp };
}

describe('оптимистичные пузыри в ленте', () => {
  it('снимает пузырь, когда та же реплика приехала в транскрипте', () => {
    const kept = keepPending(
      [bubble('сделай A', '2026-09-01T10:00:00.000Z')],
      [entry('user', 'сделай A', '2026-09-01T10:00:01.000Z')],
    );

    expect(kept).toEqual([]);
  });

  it('держит пузырь, пока транскрипт до него не дошёл', () => {
    const kept = keepPending(
      [bubble('сделай A', '2026-09-01T10:00:00.000Z')],
      [entry('assistant', 'старый ответ', '2026-09-01T09:00:00.000Z')],
    );

    expect(kept).toHaveLength(1);
  });

  it('снимает пузырь, чей текст разошёлся с транскриптом: иначе он вечный', () => {
    // Ровно этот случай и копил реплики: между пузырём и файлом стоит CLI со
    // своими хуками, и текст в транскрипте оказывается не байт в байт тем же.
    const kept = keepPending(
      [bubble('сделай A', '2026-09-01T10:00:00.000Z')],
      [
        entry('user', 'контекст\nсделай A', '2026-09-01T10:00:01.000Z'),
        entry('assistant', 'готово', '2026-09-01T10:00:30.000Z'),
      ],
    );

    expect(kept).toEqual([]);
  });

  it('несколько отправок подряд не накапливаются', () => {
    const kept = keepPending(
      [
        bubble('раз', '2026-09-01T10:00:00.000Z'),
        bubble('два', '2026-09-01T10:01:00.000Z'),
        bubble('три', '2026-09-01T10:02:00.000Z'),
      ],
      [entry('assistant', 'ответ на всё', '2026-09-01T10:03:00.000Z')],
    );

    expect(kept).toEqual([]);
  });

  it('свежую отправку не снимает вместе со старыми', () => {
    const kept = keepPending(
      [
        bubble('старое', '2026-09-01T10:00:00.000Z'),
        bubble('только что', '2026-09-01T10:05:00.000Z'),
      ],
      [entry('assistant', 'ответ', '2026-09-01T10:01:00.000Z')],
    );

    expect(kept.map((message) => message.blocks[0])).toEqual([
      { type: 'text', text: 'только что' },
    ]);
  });

  it('возвращает тот же массив, когда снимать нечего: лишний рендер крутит ленту', () => {
    const pending = [bubble('сделай A', '2026-09-01T10:00:00.000Z')];

    expect(keepPending(pending, [])).toBe(pending);
    expect(keepPending([], [entry('user', 'что угодно', '2026-09-01T10:00:00.000Z')])).toEqual([]);
  });
});
