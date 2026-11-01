import { describe, expect, it } from 'vitest';
import { moveAfter, slotTarget } from './slotTarget';

describe('shared slot rule', () => {
  it('after itself and before itself are one place: no move', () => {
    expect(slotTarget(2, 2)).toBeNull();
    // «Перед собой» = после предыдущей строки: перетаскивание говорит «не сдвинулся», а не «встал».
    expect(slotTarget(2, 1)).toBeNull();
    expect(slotTarget(0, -1)).toBeNull();
  });

  it('a later slot counts without the moved row, an earlier one as is', () => {
    expect(slotTarget(0, 2)).toBe(1);
    expect(slotTarget(3, 0)).toBe(0);
    expect(slotTarget(3, -1)).toBe(-1);
  });

  it('no move returns the same list, a move a new one in the slot order', () => {
    const items = ['a', 'b', 'c', 'd'] as const;
    expect(moveAfter(items, 2, 1)).toBe(items);
    expect(moveAfter(items, 2, 2)).toBe(items);
    expect(moveAfter(items, 0, 9)).toBe(items);
    expect(moveAfter(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveAfter(items, 3, -1)).toEqual(['d', 'a', 'b', 'c']);
  });
});
