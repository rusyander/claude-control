import { pageTabDomId } from '@shared/lib/page-tab';
import { GROUPS_PAGE } from './tabs.constants';
import { type GroupsTabId } from './tabs.types';

export function groupsTabDomId(tab: GroupsTabId): string {
  return pageTabDomId(GROUPS_PAGE, tab);
}
