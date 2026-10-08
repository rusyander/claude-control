import type { PlatformTabId } from '../model/tabs.types';

export interface PlatformTabsProps {
  active: PlatformTabId;
  onSelect: (tab: PlatformTabId) => void;
}
