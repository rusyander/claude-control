import type { ProjectTestFilter } from '@agentdeck/contracts';

/** Пустые поля из фильтра выкидываются: они ничего не сужают, но врут «фильтр стоит». */
export function dropEmpty(filter: ProjectTestFilter): ProjectTestFilter {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    // Карантин — единственный трёхзначный отбор: `false` здесь значит «спрятать
    // карантин», а не «поле не заполнено», и выкидывать его нельзя.
    if (key === 'muted' && typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (value === undefined || value === false || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result as ProjectTestFilter;
}
