import { describe, expect, it } from 'vitest';
import { formatClock } from './format-clock';

describe('formatClock', () => {
  it('время суток с секундами, без даты', () => {
    const text = formatClock('2026-09-09T10:00:04.000Z', 'ru');
    expect(text).toMatch(/^\d{1,2}:\d{2}:\d{2}/);
    expect(text).not.toContain('2026');
  });

  /**
   * F-323 (сосед): время — по языку ИНТЕРФЕЙСА, а не браузера. Русский интерфейс
   * в английском браузере показывал «10:00:04 AM».
   */
  it('формат времени — по языку интерфейса', () => {
    const iso = '2026-09-09T15:00:04.000Z';
    expect(formatClock(iso, 'en-US')).toMatch(/[AP]M/);
    expect(formatClock(iso, 'ru')).not.toMatch(/[AP]M/);
  });

  it('битая строка — пусто, не «Invalid Date»', () => {
    expect(formatClock('', 'ru')).toBe('');
    expect(formatClock('вчера', 'ru')).toBe('');
  });
});
