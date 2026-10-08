import type { PlatformRuleConflict } from '@agentdeck/contracts';

/** Ячейки, у которых фраза о победителе своя; у остальных — по значению `winner`. */
export const WINNER_CELLS = ['tools', 'anonymization', 'compaction', 'guardrails'] as const;

/**
 * Ключ фразы «кто берёт верх». Нет `winner` — ответ сервера старше выбора, и
 * экран победителя не называет вовсе: выдуманный победитель хуже молчания.
 */
export function winnerKey(cell: PlatformRuleConflict): string | undefined {
  if (!cell.winner) return undefined;
  const own = WINNER_CELLS.find((id) => id === cell.id);
  return `contourConfig.winner.${own ?? cell.winner}`;
}
