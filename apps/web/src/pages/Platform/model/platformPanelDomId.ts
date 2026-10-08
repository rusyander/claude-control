import type { PlatformTabId } from './tabs.types';

export function platformPanelDomId(id: PlatformTabId): string {
  return `platform-panel-${id}`;
}
