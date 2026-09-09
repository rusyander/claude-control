import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatDuration } from './format-duration';

const units: Record<string, string> = {
  'common.duration.h': 'ч',
  'common.duration.m': 'м',
  'common.duration.s': 'с',
};
const t = ((key: string) => units[key] ?? key) as unknown as TFunction;

describe('formatDuration', () => {
  it('секунды, минуты с секундами, часы с минутами', () => {
    expect(formatDuration(4_200, t)).toBe('4с');
    expect(formatDuration(72_000, t)).toBe('1м 12с');
    expect(formatDuration(60_000, t)).toBe('1м 00с');
    expect(formatDuration(3_780_000, t)).toBe('1ч 03м');
    expect(formatDuration(5_400_000, t)).toBe('1ч 30м');
  });

  it('отрицательное и дробное — не ломают формат', () => {
    expect(formatDuration(-5, t)).toBe('0с');
    expect(formatDuration(59_600, t)).toBe('1м 00с');
  });
});
