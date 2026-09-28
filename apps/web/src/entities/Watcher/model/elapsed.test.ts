import { describe, expect, it } from 'vitest';
import { elapsedMs } from './elapsed';

describe('время работы наблюдателя', () => {
  it('считается по часам сервера, а не браузера', () => {
    // Часы браузера отстают от сервера на час: длительность от этого не меняется.
    const status = { since: '2026-09-27T10:00:00.000Z', serverNow: '2026-09-27T10:05:00.000Z' };
    const browserReceivedAt = Date.parse('2026-09-27T09:05:00.000Z');
    expect(elapsedMs(status, browserReceivedAt, browserReceivedAt)).toBe(5 * 60_000);
    // Прошло 7 секунд по часам браузера после ответа — прибавились 7 секунд.
    expect(elapsedMs(status, browserReceivedAt, browserReceivedAt + 7000)).toBe(5 * 60_000 + 7000);
  });

  it('не включён — ноль; часы сервера «раньше» включения — не отрицательное', () => {
    expect(elapsedMs({ serverNow: '2026-09-27T10:05:00.000Z' }, 0, 1000)).toBe(0);
    expect(
      elapsedMs({ since: '2026-09-27T10:05:00.000Z', serverNow: '2026-09-27T10:00:00.000Z' }, 0, 0),
    ).toBe(0);
  });
});
