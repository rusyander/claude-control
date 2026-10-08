import type { GroupView } from '../GroupViewTabs.types';

export function groupViewPanelId(idBase: string, view: GroupView): string {
  return `${idBase}-panel-${view}`;
}
