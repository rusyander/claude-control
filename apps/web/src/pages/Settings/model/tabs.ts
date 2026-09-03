import type { IconName } from '@shared/ui/icon';

/**
 * Разделы страницы настроек.
 *
 * Порядок здесь — порядок вкладок на экране, а `id` попадает в адрес
 * (`/settings?tab=…`): ссылкой на конкретный раздел можно поделиться, и она
 * переживает перезагрузку. Иконка нужна, чтобы вкладку узнавали не только по
 * тексту — подписи короткие и на двух языках разной длины.
 */
export const SETTINGS_TABS = [
  { id: 'general', icon: 'settings' },
  { id: 'access', icon: 'lock' },
  { id: 'providers', icon: 'swap' },
  { id: 'models', icon: 'link' },
  { id: 'spend', icon: 'analytics' },
  { id: 'safety', icon: 'permissions' },
  { id: 'transfer', icon: 'file' },
] as const satisfies readonly { id: string; icon: IconName }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

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

/** Кнопка вкладки и её панель ссылаются друг на друга — id считаем в одном месте. */
export function settingsTabDomId(id: SettingsTabId): string {
  return `settings-tab-${id}`;
}

export function settingsPanelDomId(id: SettingsTabId): string {
  return `settings-panel-${id}`;
}
