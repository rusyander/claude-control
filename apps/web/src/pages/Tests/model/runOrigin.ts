import { runOrigin } from '@agentdeck/contracts/test-format';
import type { RunOriginFilter } from './runOrigin.types';

/**
 * Отбор истории по источнику импорта. Прогон автотестов панелью и отчёт сборки
 * — оба `mode:'import'`, и без отбора их не развести, не раскрывая каждую
 * запись. Записи не-импорта видны только в «все»: фильтр отвечает на вопрос
 * «что пришло из junit», а не прячет агента и ручные проходы по одному.
 */
export function filterRunsByOrigin<T extends { mode: string; origin?: string }>(
  list: T[],
  filter: RunOriginFilter,
): T[] {
  if (filter === 'all') return list;
  return list.filter((run) => runOrigin(run) === filter);
}
