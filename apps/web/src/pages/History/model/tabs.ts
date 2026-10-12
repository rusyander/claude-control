import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки «Истории изменений». «Что нового» первая и открывается по умолчанию —
 * с неё начинается разговор «что в панели изменилось»; история правок вашей
 * конфигурации — вторая. `id` попадает в адрес (`/history?tab=…`).
 */
export const HISTORY_TABS = ['changelog', 'config'] as const;

export type HistoryTabId = (typeof HISTORY_TABS)[number];

export const HISTORY_TAB_ICONS: Record<HistoryTabId, IconName> = {
  changelog: 'calendar',
  config: 'history',
};
