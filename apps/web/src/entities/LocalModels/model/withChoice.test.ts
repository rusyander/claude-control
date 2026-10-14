import { describe, expect, it } from 'vitest';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { withChoice } from './withChoice';

const info = {
  choices: {
    'a:1': { quant: 'Q4_K_M', context: 65_536, allowPartial: true },
    'b:2': { quant: 'Q8_0' },
  },
} as unknown as LocalModelsInfo;

describe('withChoice: оптимистичный выбор в снимке', () => {
  it('меняет только названное, остальное у модели остаётся', () => {
    const next = withChoice(info, { tag: 'a:1', context: 32_768 });
    expect(next.choices['a:1']).toEqual({ quant: 'Q4_K_M', context: 32_768, allowPartial: true });
  });

  it('чужие модели не трогает и исходный снимок не меняет', () => {
    const next = withChoice(info, { tag: 'a:1', quant: 'Q5_K_M' });
    expect(next.choices['b:2']).toEqual({ quant: 'Q8_0' });
    expect(info.choices['a:1']?.quant).toBe('Q4_K_M');
  });

  it('у модели без записи запись появляется', () => {
    const next = withChoice(info, { tag: 'c:3', quant: 'Q4_K_M', context: 8192 });
    expect(next.choices['c:3']).toEqual({ quant: 'Q4_K_M', context: 8192 });
  });
});
