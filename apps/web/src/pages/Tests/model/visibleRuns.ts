import type { RunOriginFilter } from './runOrigin.types';
import { hasBothOrigins } from './hasBothOrigins';
import { filterRunsByOrigin } from './runOrigin';

/**
 * Что показать в истории при выбранном отборе. Отбор действует, только пока
 * виден переключатель: e2e-прогоны ушли из истории — переключатель спрятан, и
 * отбор, оставшийся «автотестами», резал список до пустоты без способа его
 * снять (F-304).
 */
export function visibleRuns<T extends { mode: string; origin?: string }>(
  all: T[],
  chosen: RunOriginFilter,
): { list: T[]; showFilter: boolean; origin: RunOriginFilter } {
  const showFilter = hasBothOrigins(all);
  const origin = showFilter ? chosen : 'all';
  return { list: filterRunsByOrigin(all, origin), showFilter, origin };
}
