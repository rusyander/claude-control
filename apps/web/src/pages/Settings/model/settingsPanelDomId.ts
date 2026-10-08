import type { SettingsTabId } from './tabs.types';

export function settingsPanelDomId(id: SettingsTabId): string {
  return `settings-panel-${id}`;
}
