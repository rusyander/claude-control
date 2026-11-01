import type { HumanPointPolicy } from './human-point.types.ts';

/**
 * Пол политики человека (уровень 1 старшинства): настройки и хуки CLI в копии (`.claude/**`
 * исполняются вне прав шага) — пункт 5 и правка только с грантом (ревью F-12). Конфиг человека
 * пол только расширяет: маски, классы и гранты объединяются, убрать пункт пола нельзя.
 * Записи в трекер и фордж — значение конфига, без раздела — «спрашивать».
 */
export const PLATFORM_HUMAN_FLOOR: HumanPointPolicy = {
  actionClasses: [],
  pathGlobs: ['.claude/**'],
  grantRequired: [{ globs: ['.claude/**'], ops: ['edit'] }],
  trackerWrites: 'ask',
  forgeWrites: 'ask',
};

/** Раздел `humanPoints` конфига ядра (форма `humanPointsSchema`). */
export interface ConfiguredHumanPoints {
  actionClasses: readonly string[];
  pathGlobs: readonly string[];
  trackerWrites: 'ask' | 'auto';
  forgeWrites: 'ask' | 'auto';
}

type GrantRow = HumanPointPolicy['grantRequired'][number];

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/**
 * Политика сеанса = пол ∪ конфиг. `grantRequired` — строки раздела конфига ЭТОГО проекта
 * (отбор по проекту — у вызывающего); одинаковые строки не дублируются.
 */
export function withFloor(
  configured: ConfiguredHumanPoints | null | undefined,
  grantRequired: readonly GrantRow[] = [],
): HumanPointPolicy {
  const rows: GrantRow[] = [];
  const seen = new Set<string>();
  for (const row of [...PLATFORM_HUMAN_FLOOR.grantRequired, ...grantRequired]) {
    const key = JSON.stringify([[...row.globs].sort(), [...row.ops].sort()]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ globs: [...row.globs], ops: [...row.ops] });
  }
  return {
    actionClasses: union(PLATFORM_HUMAN_FLOOR.actionClasses, configured?.actionClasses ?? []),
    pathGlobs: union(PLATFORM_HUMAN_FLOOR.pathGlobs, configured?.pathGlobs ?? []),
    grantRequired: rows,
    trackerWrites: configured?.trackerWrites ?? 'ask',
    forgeWrites: configured?.forgeWrites ?? 'ask',
  };
}
