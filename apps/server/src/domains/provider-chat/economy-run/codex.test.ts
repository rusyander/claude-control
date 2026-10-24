import { describe, it, expect } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import {
  CODEX_COMPACT_LIMIT_ENV,
  CODEX_TOOL_OUTPUT_LIMIT_ENV,
  withCodexKit,
} from '../../kit/codex.ts';
import { CODEX_DEFAULT_TOOL_OUTPUT_TOKENS, codexToolOutputLimit } from './codex.ts';
import { economyRunEnv } from './economy-run.ts';

/**
 * @covers codex.ts
 * @scenario потолок ответа инструмента группы Codex (решение O2): один ключ
 *   `tool_output_token_limit` на все инструменты = max(ceil(bashOutputChars/4),
 *   readOutputTokens); ноль у любого рычага — ключа нет, решает CLI; предел не
 *   ниже собственного предела Codex (2 500 токенов, живая проба) — ключа нет:
 *   ключ поднял бы предел, а не ужал.
 */

const BASE = { env: {}, appData: '/data' };
const levers = (bashOutputChars: number, readOutputTokens: number) => ({
  ...GROUP_ECONOMY_DEFAULTS,
  bashOutputChars,
  readOutputTokens,
});

describe('economy-run codex', () => {
  it('tool output limit = max(ceil(bash/4), read)', () => {
    // Чтение шире оболочки: 8000 знаков = 2000 токенов < 2400 чтения.
    expect(codexToolOutputLimit(levers(8_000, 2_400))).toBe(2_400);
    // Оболочка шире чтения — берётся она: 9 600 / 4.
    expect(codexToolOutputLimit(levers(9_600, 2_000))).toBe(2_400);
    // Нецелое деление округляется вверх: предел не урезает больше, чем просили.
    expect(codexToolOutputLimit(levers(8_001, 2_000))).toBe(2_001);
  });

  it('never raises the CLI own limit: defaults and wide levers → no key', () => {
    // Рычаги по умолчанию (8000 знаков, 10 000 токенов) дали бы 10 000 — вчетверо
    // больше умолчания Codex (живая проба: 10 000 пропустил все 40 000 знаков).
    expect(codexToolOutputLimit(GROUP_ECONOMY_DEFAULTS)).toBeUndefined();
    expect(economyRunEnv('codex', { ...BASE, economy: GROUP_ECONOMY_DEFAULTS })).toBeUndefined();
    expect(codexToolOutputLimit(levers(128_000, 2_000))).toBeUndefined();
    // Ровно предел Codex — тоже ничего не меняет.
    expect(codexToolOutputLimit(levers(4_000, CODEX_DEFAULT_TOOL_OUTPUT_TOKENS))).toBeUndefined();
    expect(codexToolOutputLimit(levers(4_000, CODEX_DEFAULT_TOOL_OUTPUT_TOKENS - 1))).toBe(2_499);
  });

  it('a zero lever or no pinned levers → no key (the CLI decides)', () => {
    expect(codexToolOutputLimit(undefined)).toBeUndefined();
    expect(codexToolOutputLimit(levers(0, 2_000))).toBeUndefined();
    expect(codexToolOutputLimit(levers(8_000, 0))).toBeUndefined();
    expect(economyRunEnv('codex', { ...BASE, economy: levers(0, 0) })).toBeUndefined();
  });

  it('NaN, negative and infinite levers → no key; fractional ones round up', () => {
    // Испорченные настройки (ручная правка файла, старый формат) не дают ни ключа,
    // ни `NaN`/`-5`/`Infinity` в argv.
    expect(codexToolOutputLimit(levers(Number.NaN, 2_000))).toBeUndefined();
    expect(codexToolOutputLimit(levers(8_000, Number.NaN))).toBeUndefined();
    expect(codexToolOutputLimit(levers(-5, 2_000))).toBeUndefined();
    expect(codexToolOutputLimit(levers(8_000, -1))).toBeUndefined();
    expect(codexToolOutputLimit(levers(Number.POSITIVE_INFINITY, 2_000))).toBeUndefined();
    expect(economyRunEnv('codex', { ...BASE, economy: levers(-5, Number.NaN) })).toBeUndefined();
    // Дробные — вверх, как и деление знаков: предел не урезает больше, чем просили.
    expect(codexToolOutputLimit(levers(4_000, 2_000.5))).toBe(2_001);
    expect(codexToolOutputLimit(levers(8_000.7, 2_000))).toBe(2_001);
  });

  it('channel env → argv of a real withCodexKit, env var stripped', () => {
    const env = economyRunEnv('codex', {
      ...BASE,
      economy: levers(8_000, 2_000),
      compactWindow: 160_000,
    });
    expect(env).toEqual({
      [CODEX_COMPACT_LIMIT_ENV]: '160000',
      [CODEX_TOOL_OUTPUT_LIMIT_ENV]: '2000',
    });
    const run = withCodexKit(['app-server'], { ...env, KEEP: '1' }, 'appServer');
    expect(run.args).toEqual([
      'app-server',
      '-c',
      'model_auto_compact_token_limit=160000',
      '-c',
      'tool_output_token_limit=2000',
    ]);
    expect(run.env).toEqual({ KEEP: '1' });
  });
});
