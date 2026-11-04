import { describe, expect, it } from 'vitest';
import { LOCAL_FRONT_PORT, LOCAL_FRONT_PORT_ENV } from '@agentdeck/contracts/core/local-hold';
import { localFrontPortOf } from './front.ts';

// Одно чтение порта на ядро и панель (contracts): ядро слушает тот порт, куда панель ходит пробой.
describe('local front port from the environment', () => {
  it('unset or blank → the product port; a number → that port; 0 or junk → no front', () => {
    expect(localFrontPortOf({})).toBe(LOCAL_FRONT_PORT);
    expect(localFrontPortOf({ [LOCAL_FRONT_PORT_ENV]: '  ' })).toBe(LOCAL_FRONT_PORT);
    expect(localFrontPortOf({ [LOCAL_FRONT_PORT_ENV]: '18435' })).toBe(18_435);
    for (const off of ['0', 'abc', '-1', '65536', '1.5'])
      expect(localFrontPortOf({ [LOCAL_FRONT_PORT_ENV]: off })).toBeUndefined();
  });
});
