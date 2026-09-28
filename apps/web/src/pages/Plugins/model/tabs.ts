import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Плагины»: что уже стоит, что можно поставить, откуда оно
 * берётся и свой плагин с нуля. `id` попадает в адрес (`/plugins?tab=…`).
 */
export const PLUGINS_TABS = ['installed', 'catalog', 'marketplaces', 'scaffold'] as const;

export type PluginsTabId = (typeof PLUGINS_TABS)[number];

export const PLUGINS_TAB_ICONS: Record<PluginsTabId, IconName> = {
  installed: 'plugins',
  catalog: 'search',
  marketplaces: 'link',
  scaffold: 'plus',
};
