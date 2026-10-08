import type { EnvNeeds } from '@agentdeck/contracts/portable-env';

/**
 * Требования записи одной строкой: список фактов либо причина, по которой их
 * нет. «Ничего не нужно» и «определить не удалось» — РАЗНЫЕ вещи, и на экране
 * они обязаны читаться по-разному: из первого следует, что запись переедет
 * куда угодно, из второго — что переносить её вслепую нельзя.
 */
export function needsSummary(needs: EnvNeeds): { facts: readonly string[]; why: string | null } {
  if (needs.resolution === 'facts') return { facts: needs.facts, why: null };
  return { facts: [], why: needs.why };
}
