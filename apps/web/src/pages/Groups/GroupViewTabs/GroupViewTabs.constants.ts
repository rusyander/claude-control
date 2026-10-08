import type { GroupView } from '../GroupViewTabs.types';

export const VIEWS: GroupView[] = ['path', 'members'];

export const LABEL_KEYS: Record<GroupView, string> = {
  path: 'groupPath.tabPath',
  members: 'groupPath.tabMembers',
};
