import { describe, expect, it } from 'vitest';
import { formatClock } from './format-clock';

describe('formatClock', () => {
  it('время суток с секундами, без даты', () => {
    const text = formatClock('2026-09-09T10:00:04.000Z');
    expect(text).toMatch(/^\d{1,2}:\d{2}:\d{2}/);
    expect(text).not.toContain('2026');
  });

  it('битая строка — пусто, не «Invalid Date»', () => {
    expect(formatClock('')).toBe('');
    expect(formatClock('вчера')).toBe('');
  });
});
