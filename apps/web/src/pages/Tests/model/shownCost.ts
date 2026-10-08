/**
 * Цена для показа. Ноль — не «бесплатно», а «цены нет»: прогоны по подписке её
 * не несут, и «$0.00» рядом с миллионом токенов обманывал.
 */
export function shownCost(costUsd: number | undefined): string | undefined {
  return costUsd && costUsd > 0 ? costUsd.toFixed(2) : undefined;
}
