/**
 * «Закончила …» в сводке групп — грубо и без секунд (владелец 20.10).
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatAgo } from './format-ago';

const t = ((key: string, params?: { count?: number; date?: string }) =>
  `${key}|${params?.count ?? params?.date ?? ''}`) as unknown as TFunction;

const now = Date.parse('2026-10-20T12:00:00Z');

describe('formatAgo', () => {
  it('меньше минуты — «только что», без секунд', () => {
    expect(formatAgo(now - 59_000, now, t, 'ru')).toBe('common.ago.justNow|');
  });

  it('минуты — целыми, секунды отброшены: 36 мин 35 с → 36 мин', () => {
    expect(formatAgo(now - (36 * 60 + 35) * 1000, now, t, 'ru')).toBe('common.ago.minutes|36');
  });

  it('часы — целыми до суток', () => {
    expect(formatAgo(now - 3.5 * 3600_000, now, t, 'ru')).toBe('common.ago.hours|3');
    expect(formatAgo(now - 23.9 * 3600_000, now, t, 'ru')).toBe('common.ago.hours|23');
  });

  it('старше суток — дата и время, а не «N ч назад»', () => {
    const out = formatAgo(now - 30 * 3600_000, now, t, 'ru');
    expect(out.startsWith('common.ago.at|')).toBe(true);
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it('время из будущего (часы машин разошлись) — «только что», не минус', () => {
    expect(formatAgo(now + 5_000, now, t, 'ru')).toBe('common.ago.justNow|');
  });
});
