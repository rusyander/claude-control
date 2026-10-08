import type { PlatformTabId } from './tabs.types';

export function platformTabDomId(id: PlatformTabId): string {
  return `platform-tab-${id}`;
}
