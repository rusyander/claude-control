import { describe, expect, it } from 'vitest';
import { formatTime } from './formatTime';

/**
 * Время сброса лимита — на языке ИНТЕРФЕЙСА, а не браузера (F-323, соседи):
 * русский интерфейс в английском браузере показывал «03:04 PM».
 */
describe('formatTime', () => {
  const at = Date.UTC(2026, 8, 8, 15, 4, 5) / 1000;

  it('русский интерфейс — 24 часа, без AM/PM', () => {
    expect(formatTime(at, 'ru')).not.toMatch(/AM|PM/);
    expect(formatTime(at, 'ru')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('английский интерфейс — английская запись с AM/PM', () => {
    expect(formatTime(at, 'en-US')).toMatch(/\d{2}:\d{2}\s?(AM|PM)/);
  });
});
