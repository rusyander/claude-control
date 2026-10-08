import type { GroupsTabId } from './tabs.types';
import { pageTabPanelDomId } from '@shared/lib/page-tab';
import { GROUPS_PAGE } from './tabs.constants';

export function groupsPanelDomId(tab: GroupsTabId): string {
  return pageTabPanelDomId(GROUPS_PAGE, tab);
}
