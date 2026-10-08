import type { GroupsTabCount } from '../GroupsTabs/GroupsTabs.types';
import type { TFunction } from 'i18next';

/** То же для скринридера — словами. */
export function spokenCount(count: GroupsTabCount['count'], t: TFunction): string {
  if (count === 'loading') return t('groupsPage.tabCountLoading');
  if (count === 'failed') return t('groupsPage.tabCountFailed');
  return String(count);
}
