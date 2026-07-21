import type { SearchResult, SearchResultKind } from '@claude-control/contracts';

/**
 * Группировка результатов поиска по разделам. Сервер отдаёт плоский список — на
 * экране его удобнее показывать секциями, поэтому раскладываем по видам в
 * фиксированном порядке (как в навигации) и выкидываем пустые группы.
 */

export interface SearchGroup {
  kind: SearchResultKind;
  results: SearchResult[];
}

/** Порядок разделов в выдаче — тот же, что и в боковой навигации. */
export const SEARCH_KIND_ORDER: readonly SearchResultKind[] = [
  'rule',
  'skill',
  'hook',
  'script',
  'plugin',
  'mcp',
  'permission',
  'env',
];

export function groupResults(results: readonly SearchResult[]): SearchGroup[] {
  const byKind = new Map<SearchResultKind, SearchResult[]>();

  for (const result of results) {
    const list = byKind.get(result.kind);
    if (list) list.push(result);
    else byKind.set(result.kind, [result]);
  }

  return SEARCH_KIND_ORDER.map((kind) => ({ kind, results: byKind.get(kind) ?? [] })).filter(
    (group) => group.results.length > 0,
  );
}
