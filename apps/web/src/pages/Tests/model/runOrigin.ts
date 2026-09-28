import { runOrigin } from '@agentdeck/contracts/test-format';

/** Какие записи истории показать: все, только автотесты панели или только импорт из CI. */
export type RunOriginFilter = 'all' | 'e2e' | 'ci';

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

/**
 * Показывать ли отбор: он нужен, только когда в истории есть оба источника —
 * иначе выбор из одного варианта ничего не меняет и только занимает строку.
 */
export function hasBothOrigins(list: { mode: string; origin?: string }[]): boolean {
  const seen = new Set(list.map((run) => runOrigin(run)).filter(Boolean));
  return seen.has('e2e') && seen.has('ci');
}

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

/**
 * Ключи подписей записи в истории: режим и кто гонял. Прогон автотестов
 * панелью подписан «автотесты» · «панель», а не «импорт» · «CI» — иначе он
 * неотличим от отчёта сборки, хотя запускала его сама панель.
 */
export function runLabelKeys(run: { mode: string; actor: string; origin?: string }): {
  mode: string;
  actor: string;
} {
  if (runOrigin(run) === 'e2e') {
    return { mode: 'tests.runs.origin.e2e', actor: 'tests.runs.origin.e2eActor' };
  }
  return { mode: `tests.runs.mode.${run.mode}`, actor: `tests.runs.actor.${run.actor}` };
}
