import type { PlatformBudgetState, PlatformStatus } from '@agentdeck/contracts';

/**
 * Пустой итог по бюджету и пустой расход — на случай СЕРВЕРА СТАРЕЕ ФРОНТА.
 *
 * Обе величины появились в Т8, и панель, у которой сервер ещё не перезапущен
 * (обычное дело при `pnpm dev`), присылает карточку без них. Читать их напрямую
 * значило бы уронить весь раздел «Контур» из-за строки расхода: карточка обязана
 * промолчать, а не рухнуть, — ровно как со сводкой проверок шлюза.
 */
export const NO_BUDGET: PlatformBudgetState = {
  spentUsd: 0,
  budgetUsd: 0,
  share: 0,
  tracked: false,
  overEstimate: false,
  nearLimit: false,
  exhausted: false,
};

export function platformBudgetOf(status: PlatformStatus): PlatformBudgetState {
  return (status.budget as PlatformBudgetState | undefined) ?? NO_BUDGET;
}
