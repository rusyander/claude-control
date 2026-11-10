/**
 * Адрес раздела «Задачи ядра» (этап 12, D13): `?view=board|list` — вид (по умолчанию доска,
 * список — переключатель), `?lane=group` — полосы групп, `?group=<id>` — отбор одной группы.
 * Общий разбор адреса панели (`validateSearch`) эти ключи срезал бы — маршрут `/core` дописывает
 * их своим разбором поверх общего.
 */
import { CORE_GROUP_LANES_SEARCH } from '@shared/config/routes';

export const CORE_VIEWS = ['board', 'list'] as const;
export type CoreView = (typeof CORE_VIEWS)[number];

export interface CoreBoardSearch {
  view?: CoreView;
  lane?: 'group';
  group?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Ключи доски из сырого адреса; неизвестное значение отбрасывается, а не угадывается. */
export function coreBoardSearch(search: Record<string, unknown>): CoreBoardSearch {
  const view = text(search.view);
  const lane = text(search.lane);
  const group = text(search.group);
  return {
    ...(view && (CORE_VIEWS as readonly string[]).includes(view) ? { view: view as CoreView } : {}),
    ...(lane === 'group' ? { lane: 'group' as const } : {}),
    ...(group ? { group } : {}),
  };
}

/** Вид раздела: адрес главнее, без ключа — доска (D13: `/core` по умолчанию доска). */
export function coreViewOf(search: { view?: string | undefined }): CoreView {
  return search.view === 'list' ? 'list' : 'board';
}

/**
 * Куда ведёт прежний адрес `/groups` (D13, P160): доска в режиме полос групп. Прежние ключи
 * страницы групп (`tab`, `show`) смысла на доске не имеют и не переносятся.
 */
export function groupsBoardTarget(): { to: '/core'; search: CoreBoardSearch } {
  return { to: '/core', search: { ...CORE_GROUP_LANES_SEARCH } };
}
