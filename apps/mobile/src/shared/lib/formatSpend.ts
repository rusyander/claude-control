import { compact } from './format';

export type CostUnit = 'tokens' | 'money';

/** Расход в выбранных единицах — токены или деньги, как настроено в панели. */
export function formatSpend(unit: CostUnit, tokens: number, costUsd: number): string {
  return unit === 'money' ? `$${costUsd.toFixed(3)}` : `${compact(tokens)} tok`;
}
