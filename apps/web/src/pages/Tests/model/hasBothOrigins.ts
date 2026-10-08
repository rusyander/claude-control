import { runOrigin } from '@agentdeck/contracts/test-format';

/**
 * Показывать ли отбор: он нужен, только когда в истории есть оба источника —
 * иначе выбор из одного варианта ничего не меняет и только занимает строку.
 */
export function hasBothOrigins(list: { mode: string; origin?: string }[]): boolean {
  const seen = new Set(list.map((run) => runOrigin(run)).filter(Boolean));
  return seen.has('e2e') && seen.has('ci');
}
