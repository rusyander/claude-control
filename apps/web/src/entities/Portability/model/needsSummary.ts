import type { EnvNeeds } from '@agentdeck/contracts/portable-env';
import type { ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { serverFieldText } from '@shared/config/i18n';

/**
 * Требования записи одной строкой: список фактов либо причина, по которой их
 * нет. «Ничего не нужно» и «определить не удалось» — РАЗНЫЕ вещи, и на экране
 * они обязаны читаться по-разному: из первого следует, что запись переедет
 * куда угодно, из второго — что переносить её вслепую нельзя.
 */
export function needsSummary(
  needs: EnvNeeds,
  translate?: (key: string, options?: ServerMessageParams) => string,
): { facts: readonly string[]; why: string | null } {
  if (needs.resolution === 'facts') return { facts: needs.facts, why: null };
  // Причину сервер пишет по-русски и кладёт рядом код (`whyCode`): под английским
  // интерфейсом русская фраза читалась сбоем перевода.
  return { facts: [], why: serverFieldText(needs, 'why', translate) || needs.why };
}
