import type { ReactNode } from 'react';
import type { GroupsTabId } from '../model/tabs.types';

export interface GroupsTabPanelProps {
  tab: GroupsTabId;
  /** Одна строка «что здесь» над содержимым вкладки. */
  hint: string;
  children: ReactNode;
}
