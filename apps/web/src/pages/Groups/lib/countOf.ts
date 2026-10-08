import type { GroupsTabCount } from '../GroupsTabs/GroupsTabs.types';

/** Число вкладки по состоянию запроса: пока читается или упал — не ноль. */
export function countOf(
  query: { isPending: boolean; isError: boolean; data?: unknown },
  count: number,
): GroupsTabCount['count'] {
  // Прочитанное раньше не отменяется упавшим повторным запросом.
  if (query.data !== undefined) return count;
  if (query.isError) return 'failed';
  if (query.isPending) return 'loading';
  return count;
}
