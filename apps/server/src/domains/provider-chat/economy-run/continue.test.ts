import { describe, it, expect } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import {
  CONTINUE_BASH_OUTPUT_ENV,
  CONTINUE_READ_OUTPUT_ENV,
  continueEconomyEnv,
} from './continue.ts';
import { economyRunEnv } from './economy-run.ts';

/**
 * @covers continue.ts
 * @scenario рычаги группы Continue — две независимые переменные `cn` (живая проба
 *   1.5.47): вывод оболочки в знаках как есть, чтение файла — токены × 4; ноль —
 *   своя переменная не ставится; окно сжатия у одиночного запуска не трогается.
 */

const BASE = { env: {}, appData: '/data' };
const levers = (bashOutputChars: number, readOutputTokens: number) => ({
  ...GROUP_ECONOMY_DEFAULTS,
  bashOutputChars,
  readOutputTokens,
});

describe('economy-run continue', () => {
  it('chars from tokens', () => {
    expect(continueEconomyEnv({ ...BASE, economy: levers(8_000, 10_000) })).toEqual({
      [CONTINUE_BASH_OUTPUT_ENV]: '8000',
      [CONTINUE_READ_OUTPUT_ENV]: '40000',
    });
  });

  it('zero lever — its variable is not set; the other stays', () => {
    expect(continueEconomyEnv({ ...BASE, economy: levers(0, 2_000) })).toEqual({
      [CONTINUE_READ_OUTPUT_ENV]: '8000',
    });
    expect(continueEconomyEnv({ ...BASE, economy: levers(6_000, 0) })).toEqual({
      [CONTINUE_BASH_OUTPUT_ENV]: '6000',
    });
    expect(continueEconomyEnv({ ...BASE, economy: levers(0, 0) })).toBeUndefined();
  });

  it('no pinned levers or only a compact window — nothing to change', () => {
    expect(continueEconomyEnv({ ...BASE })).toBeUndefined();
    expect(economyRunEnv('continue', { ...BASE, compactWindow: 160_000 })).toBeUndefined();
  });
});
