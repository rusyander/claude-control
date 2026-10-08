import type { SettingsTabId } from './tabs.types';

/** Кнопка вкладки и её панель ссылаются друг на друга — id считаем в одном месте. */
export function settingsTabDomId(id: SettingsTabId): string {
  return `settings-tab-${id}`;
}
