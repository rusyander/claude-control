import { describe, expect, it } from 'vitest';
import { pageCursor, streamAfter } from './agents.ts';

/**
 * Курсор потока дерева агентов (этап 11, P147): `Last-Event-ID` главнее `?after=`; курсор —
 * только целое число цифрами. Пробел, экспонента, дробь, знак — 400 (`NaN`), а не тихий повтор
 * всего журнала с начала.
 */

describe('stage 11 agents stream cursor', () => {
  it('Last-Event-ID wins over ?after=; none of them is a snapshot (null)', () => {
    expect(streamAfter('7', { after: '3' })).toBe(7);
    expect(streamAfter(['5', '9'], {})).toBe(5);
    expect(streamAfter(undefined, { after: '3' })).toBe(3);
    expect(streamAfter(undefined, {})).toBeNull();
    expect(streamAfter('', { after: '' })).toBeNull();
    expect(streamAfter(undefined, { after: '0' })).toBe(0);
  });

  it('a cursor that is not plain digits is refused, never read as 0 or a big number', () => {
    for (const bad of [' ', '1e3', '1.5', '-1', '+2', 'x', '0x10', '9'.repeat(20)])
      expect(streamAfter(bad, {}), bad).toBeNaN();
    expect(streamAfter(undefined, { after: ['1', '2'] })).toBeNaN();
  });

  it('a page cursor of node calls is digits or absent; anything else is refused (undefined → 400)', () => {
    expect(pageCursor(undefined)).toBeNull();
    expect(pageCursor('')).toBeNull();
    expect(pageCursor('100')).toBe('100');
    for (const bad of ['abc', '1e3', '-1', ' ', '1.5', '9'.repeat(20), ['1', '2']])
      expect(pageCursor(bad), String(bad)).toBeUndefined();
  });
});
