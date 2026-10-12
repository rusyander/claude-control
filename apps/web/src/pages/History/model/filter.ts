import type { ChangelogEntry, ChangelogKind } from '@agentdeck/contracts/changelog';

export type SourceFilter = 'all' | 'curated' | 'git';

export const SOURCE_FILTERS: readonly SourceFilter[] = ['all', 'curated', 'git'];

/** Виды, которые есть у записи: у выпуска без пунктов — его главный вид. */
export function entryKinds(entry: ChangelogEntry): Set<ChangelogKind> {
  // Правки рабочей копии — числа без смысла: видов у них нет.
  if (entry.source === 'tree') return new Set();
  const kinds = new Set(entry.items.map((item) => item.kind));
  if (kinds.size === 0) kinds.add(entry.kind);
  return kinds;
}

export function bySource(entries: ChangelogEntry[], source: SourceFilter): ChangelogEntry[] {
  if (source === 'all') return entries;
  // Незакоммиченные правки — тоже «из git»: это его diff против HEAD.
  if (source === 'git') return entries.filter((entry) => entry.source !== 'curated');
  return entries.filter((entry) => entry.source === source);
}

/** Пустой набор видов — без отбора по виду; иначе нужен хотя бы один из выбранных. */
export function filterEntries(
  entries: ChangelogEntry[],
  source: SourceFilter,
  kinds: ReadonlySet<ChangelogKind>,
): ChangelogEntry[] {
  const inSource = bySource(entries, source);
  if (kinds.size === 0) return inSource;
  return inSource.filter((entry) => [...entryKinds(entry)].some((kind) => kinds.has(kind)));
}

/** Сколько записей даёт каждый вид при выбранном источнике — число на чипе фильтра. */
export function kindCounts(
  entries: ChangelogEntry[],
  source: SourceFilter,
): Map<ChangelogKind, number> {
  const counts = new Map<ChangelogKind, number>();
  for (const entry of bySource(entries, source)) {
    for (const kind of entryKinds(entry)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}
