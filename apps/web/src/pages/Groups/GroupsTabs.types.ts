import type { GroupsTabId } from './model/tabs';

export interface GroupsTabCount {
  /**
   * Сколько в разделе: групп, находок или источников обнаружения. `loading` —
   * ещё читается, `failed` — не прочиталось: ноль в обоих случаях соврал бы.
   */
  count: number | 'loading' | 'failed';
  /** Сколько источников споткнулось — только у «Обнаружения»; видно на вкладке. */
  errors?: number;
}

export interface GroupsTabsProps {
  active: GroupsTabId;
  counts: Record<GroupsTabId, GroupsTabCount>;
  onSelect: (tab: GroupsTabId) => void;
}
