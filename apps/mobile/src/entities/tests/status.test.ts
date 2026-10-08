import { describe, expect, it } from 'vitest';
import { formatWhen } from './formatWhen';

describe('formatWhen', () => {
  // Дата прогона — на языке интерфейса приложения, а не системы телефона: русский
  // интерфейс на английском телефоне показывал «9/28/2026, 3:04:00 PM» (F-323).
  it('пишет момент на языке интерфейса', () => {
    const at = '2026-09-28T15:04:00Z';
    expect(formatWhen(at, 'ru')).toBe(new Date(at).toLocaleString('ru'));
    expect(formatWhen(at, 'en')).toBe(new Date(at).toLocaleString('en'));
    expect(formatWhen(at, 'ru')).not.toBe(formatWhen(at, 'en'));
  });

  it('пусто без прогона, битое значение — как пришло', () => {
    expect(formatWhen(undefined, 'ru')).toBe('');
    expect(formatWhen('вчера', 'en')).toBe('вчера');
  });
});
