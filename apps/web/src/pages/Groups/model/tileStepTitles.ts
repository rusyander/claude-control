import type { Group } from '@agentdeck/contracts';

/** Сколько шагов карточка называет словами; остальные — числом «и ещё N». */
export const TILE_PREVIEW_STEPS = 3;

export interface TileStepTitles {
  titles: string[];
  /** Сколько шагов не поместилось в превью. */
  more: number;
}

/**
 * Первые шаги прежней группы словами — из её собственного «Пути» (заголовок на языке интерфейса,
 * пустой — заголовок другого языка), а у группы без «Пути» — из старого «Порядка работы». Тот же
 * выбор источника, что у перевода в ядро (`fromPathBody`): карточка называет ровно то, что уйдёт в
 * сценарий ядра. Сетка только для чтения (этап 10, F1) — ни запроса пути, ни состава у неё нет.
 */
export function tileStepTitles(
  group: Pick<Group, 'path' | 'scenario'>,
  lang: string,
  limit = TILE_PREVIEW_STEPS,
): TileStepTitles {
  const own = group.path?.steps ?? [];
  const isEn = lang.startsWith('en');
  const all =
    own.length > 0
      ? own.map((step) => (isEn ? step.title.en || step.title.ru : step.title.ru || step.title.en))
      : (group.scenario?.steps ?? []).map((step) => step.title);
  const titles = all.map((title) => title.trim()).filter(Boolean);
  return { titles: titles.slice(0, limit), more: Math.max(0, titles.length - limit) };
}
