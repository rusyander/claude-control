import { describe, expect, it } from 'vitest';
import { SCROLL_REQUEST_TTL_MS, scrollDecision } from './virtual-list.lib';

describe('scrollDecision — просьба прокрутить к строке (F-339)', () => {
  it('строка есть — прокрутить', () => {
    expect(scrollDecision({ index: 3, requestedAt: 0, now: 100 })).toBe('scroll');
  });

  it('строки пока нет — ждать, пока просьба свежая', () => {
    expect(scrollDecision({ index: -1, requestedAt: 0, now: SCROLL_REQUEST_TTL_MS })).toBe('wait');
  });

  it('строку вернул фильтр через минуту — прыжка нет, просьба забыта', () => {
    expect(scrollDecision({ index: 7, requestedAt: 0, now: 60_000 })).toBe('drop');
    expect(scrollDecision({ index: -1, requestedAt: 0, now: 60_000 })).toBe('drop');
  });
});
