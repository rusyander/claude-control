import { SETTINGS_TABS } from './tabs.constants';
import type { SettingsTabId } from './tabs.types';

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general';

/**
 * Раздел из адреса. Незнакомое значение не показываем пустым экраном и не
 * считаем ошибкой — открываем первый раздел: адрес мог устареть после
 * переименования вкладки.
 */
export function findSettingsTab(id: string | undefined): SettingsTabId {
  const found = SETTINGS_TABS.find((tab) => tab.id === id);
  return found ? found.id : DEFAULT_SETTINGS_TAB;
}
