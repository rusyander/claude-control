import type { ModelFitLevel } from '@agentdeck/contracts/local-models';

/** Группа строки: влезает целиком (в карту или, при счёте на процессоре, в оперативную) → частично → не влезет. */
const FIT_RANK: Record<ModelFitLevel, number> = { gpu: 1, cpu: 1, partial: 2, none: 3 };

/**
 * Лучший выбор сверху (владелец 15.10): «Рекомендуем», затем по готовому подбору строки —
 * целиком, частично, не влезет. Внутри группы — порядок файла каталога (сортировка устойчива).
 * Подбор берётся без выбора человека (`fit`), поэтому строки не прыгают, пока он крутит списки.
 */
export function orderCatalogRows<T extends { recommended: boolean; fit: { level: ModelFitLevel } }>(
  rows: T[],
): T[] {
  const rank = (row: T): number => (row.recommended ? 0 : FIT_RANK[row.fit.level]);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}
