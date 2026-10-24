import { describe, expect, it } from 'vitest';
import { GroupLedgers, groupKeyOf } from './group-ledgers.ts';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const MIN = 60_000;

describe('group ledgers', () => {
  it('keeps the burn per group under its own cap and span, forgets a quiet group', () => {
    const ledgers = new GroupLedgers();
    const key = groupKeyOf('parent', 1);
    for (let n = 0; n < 5_010; n++) ledgers.noteCall(key, { t: T0 + n, weight: 1 });
    expect(ledgers.burnOf(key)).toHaveLength(5_000);
    expect(ledgers.burnOf(key)[0]?.t).toBe(T0 + 10);
    ledgers.noteCall(groupKeyOf('parent', 2), { t: T0, weight: 1 });
    // Через два часа с минутой оба списка пусты — группы забыты.
    ledgers.prune(T0 + 121 * MIN + 5_010);
    expect(ledgers.burnOf(key)).toEqual([]);
    expect(ledgers.burnOf(groupKeyOf('parent', 2))).toEqual([]);
  });

  it('keeps the account limit samples under their own cap and a three-hour span', () => {
    const ledgers = new GroupLedgers();
    for (let n = 0; n < 1_005; n++) ledgers.noteLimit({ t: T0 + n, utilization: 0.1, resetsAt: 1 });
    expect(ledgers.limits).toHaveLength(1_000);
    ledgers.noteLimit({ t: T0 + 200 * MIN, utilization: 0.2, resetsAt: 2 });
    ledgers.prune(T0 + 200 * MIN);
    expect(ledgers.limits).toEqual([{ t: T0 + 200 * MIN, utilization: 0.2, resetsAt: 2 }]);
  });
});
