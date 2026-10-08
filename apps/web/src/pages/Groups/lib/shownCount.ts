import type { GroupsTabCount } from '../GroupsTabs/GroupsTabs.types';

/** Число на вкладке: «…» — читается, «!» — не прочиталось. */
export function shownCount(count: GroupsTabCount['count']): string {
  if (count === 'loading') return '…';
  if (count === 'failed') return '!';
  return String(count);
}
