import type { TokenTotals } from '@agentdeck/contracts';

/** Пять токен-колонок в фиксированном порядке — общий хвост числовых секций. */
export function tokenCells(totals: TokenTotals): Array<string | number> {
  return [
    totals.total,
    totals.input,
    totals.output,
    totals.cacheRead,
    totals.cacheCreation,
    totals.requests,
  ];
}
