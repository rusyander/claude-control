import type { GroupView } from '../GroupViewTabs.types';

export function groupViewTabId(idBase: string, view: GroupView): string {
  return `${idBase}-tab-${view}`;
}
