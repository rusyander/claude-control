import type { AppSettings } from '@agentdeck/contracts';
import type { SettingsTabId } from './model/tabs';

export interface SettingsTabsProps {
  active: SettingsTabId;
  onSelect: (tab: SettingsTabId) => void;
}

/** Общий вход раздела: сохранённые настройки и способ их изменить. */
export interface SettingsTabProps {
  settings: AppSettings;
  patch: (change: Partial<AppSettings>) => void;
}
