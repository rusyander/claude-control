import { describe, expect, it } from 'vitest';
import { formatClock, formatDateTime } from './format';

/**
 * Время на телефоне — на языке ИНТЕРФЕЙСА приложения, а не системы (F-323,
 * соседи): русский интерфейс на английском телефоне показывал «03:04 PM».
 */
describe('время на языке интерфейса', () => {
  const iso = '2026-09-08T15:04:05.000Z';

  it('часы: ru — 24 часа, en — AM/PM; секунды по просьбе', () => {
    expect(formatClock(iso, 'ru')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatClock(iso, 'en')).toMatch(/^\d{2}:\d{2}\s?(AM|PM)$/);
    expect(formatClock(iso, 'ru', { seconds: true })).toMatch(/^\d{2}:\d{2}:05$/);
  });

  it('дата со временем: ru — «08.09.2026», en — «9/8/2026»', () => {
    expect(formatDateTime(iso, 'ru')).toMatch(/^08\.09\.2026/);
    expect(formatDateTime(iso, 'en')).toMatch(/^9\/8\/2026/);
  });

  it('битая строка — пусто, а не «Invalid Date»', () => {
    expect(formatClock('не дата', 'ru')).toBe('');
    expect(formatDateTime('не дата', 'en')).toBe('');
  });
});
