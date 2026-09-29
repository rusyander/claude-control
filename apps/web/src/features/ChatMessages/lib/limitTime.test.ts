import { describe, expect, it } from 'vitest';

import { limitTime } from './limitTime';

describe('limitTime', () => {
  const now = new Date(2026, 8, 29, 12, 30);

  it('сегодня — только часы', () => {
    expect(limitTime(new Date(2026, 8, 29, 17, 0).toISOString(), 'ru', now)).toBe('17:00');
  });

  it('другой день — часы и дата, чтобы «08:00» не читалось как сегодня', () => {
    const text = limitTime(new Date(2026, 9, 1, 8, 0).toISOString(), 'ru', now);
    expect(text).toMatch(/^08:00, 1 окт/);
  });

  it('битая строка — пусто, не «Invalid Date»', () => {
    expect(limitTime('нет', 'ru', now)).toBeUndefined();
  });
});
