import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@agentdeck/contracts/core/ids';
import { createIdSource, newId } from './uuidv7.ts';

describe('uuidv7 ids', () => {
  it('P49 every id is a valid UUIDv7, issued synchronously before any spawn, sorted by issue order', () => {
    let ms = 1_760_000_000_000;
    const source = createIdSource(() => ms);
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      if (i % 1000 === 0) ms += 1;
      ids.push(source.next());
    }
    for (const id of ids) expect(uuidv7.safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7.safeParse(newId()).success).toBe(true);
  });

  it('P49 a clock that stands still or steps back keeps order (no temp key, no collision)', () => {
    const times = [100, 100, 99, 50, 101];
    const source = createIdSource(() => times.shift() ?? 101);
    const ids = Array.from({ length: 5 }, () => source.next());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5);
  });

  it('P49 counter overflow inside one millisecond rolls into the next millisecond, still ordered', () => {
    const source = createIdSource(() => 5);
    const ids = Array.from({ length: 0x1000 + 10 }, () => source.next());
    expect([...ids].sort()).toEqual(ids);
  });
});
