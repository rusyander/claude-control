/**
 * Типы `conductor/safepoint` (G10, 02:36): безопасная точка сессии шага — где её можно снять или
 * сменить ей сценарий, ничего не оборвав.
 */

export interface SafepointInput {
  /** Инструменты, запрошенные моделью и ещё без результата (`tool.requested` без `tool.result`). */
  toolsOpen: number;
  /** Прогоны проверок единицы шага в очереди, аренде или работе (свёртка `checks`). */
  checksInFlight: number;
  /** Последнее событие сессии — конец хода: модель ждёт нас, а не мы её. */
  atTurnEnd: boolean;
}

/** Решение класса `safepoint` (00 §Decision classes). */
export interface SafepointDecision {
  safe: boolean;
  reasons: string[];
}
