import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { collectMessageTimings, formatDurationWith } from '@agentdeck/contracts/chat-timing';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 9, 10, 0, seconds)).toISOString();

const message = (id: string, role: 'user' | 'assistant', timestamp: string): ChatMessage => ({
  id,
  role,
  timestamp,
  blocks: [{ type: 'text', text: id }],
});

describe('время работы агента по записям', () => {
  it('шаг — от предыдущей записи прогона, итог — у последней записи прогона', () => {
    const timings = collectMessageTimings([
      message('h1', 'user', at(0)),
      message('a1', 'assistant', at(4)),
      message('a2', 'assistant', at(76)),
      message('h2', 'user', at(100)),
      message('a3', 'assistant', at(103)),
    ]);
    expect(timings.get('a1')).toEqual({ stepMs: 4000, from: at(0), to: at(4) });
    expect(timings.get('a2')).toEqual({
      stepMs: 72_000,
      from: at(4),
      to: at(76),
      runTotalMs: 76_000,
    });
    expect(timings.get('a3')).toEqual({
      stepMs: 3000,
      from: at(100),
      to: at(103),
      runTotalMs: 3000,
    });
    expect(timings.has('h1')).toBe(false);
  });

  it('идущий прогон итога у хвоста не получает', () => {
    const timings = collectMessageTimings(
      [message('h1', 'user', at(0)), message('a1', 'assistant', at(9))],
      { openRun: true },
    );
    expect(timings.get('a1')).toEqual({ stepMs: 9000, from: at(0), to: at(9) });
  });

  it('запись без времени пуста и соседям времени не даёт', () => {
    const timings = collectMessageTimings([
      message('h1', 'user', at(0)),
      message('a1', 'assistant', ''),
      message('a2', 'assistant', at(30)),
      message('h2', 'user', ''),
      message('a3', 'assistant', at(60)),
    ]);
    expect(timings.has('a1')).toBe(false);
    // Предыдущая запись без времени — шаг не измерить.
    expect(timings.has('a2')).toBe(false);
    // Реплика человека без времени — прогон без старта: ни шага, ни итога.
    expect(timings.has('a3')).toBe(false);
  });

  it('часы назад не ходят: перепутанные записи дают ноль, а не минус', () => {
    const timings = collectMessageTimings([
      message('h1', 'user', at(10)),
      message('a1', 'assistant', at(5)),
    ]);
    expect(timings.get('a1')?.stepMs).toBe(0);
  });
});

describe('формат длительности', () => {
  const units = { h: 'ч', m: 'м', s: 'с' };
  it('секунды, минуты с секундами, часы с минутами', () => {
    expect(formatDurationWith(4200, units)).toBe('4с');
    expect(formatDurationWith(72_000, units)).toBe('1м 12с');
    expect(formatDurationWith(3_780_000, units)).toBe('1ч 03м');
    expect(formatDurationWith(-5, units)).toBe('0с');
  });
});
