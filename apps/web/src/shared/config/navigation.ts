import type { IconName } from '@shared/ui/icon';

/**
 * Единый реестр разделов навигации. Раньше список жил в боковой панели, но его
 * читают уже трое: сама панель, командная палитра (быстрый переход) и глобальные
 * горячие клавиши. Держим один источник правды в shared, чтобы разделы не
 * разъезжались по трём местам.
 */

export interface NavItem {
  path: string;
  /** Ключ i18n для подписи. */
  label: string;
  icon: IconName;
  /** Ключ счётчика в сводке — не у всех разделов он есть. */
  key: string;
}

export interface NavSection {
  /** Ключ i18n подписи секции. */
  label: string;
  items: NavItem[];
}

/**
 * Навигация сгруппирована по смыслу: сначала то, что настраивает поведение
 * Claude, затем доступы и окружение, затем сам инструмент.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'nav.sectionMain',
    items: [
      { path: '/', label: 'nav.overview', icon: 'overview', key: 'overview' },
      { path: '/search', label: 'nav.search', icon: 'search', key: 'search' },
      { path: '/analytics', label: 'nav.analytics', icon: 'analytics', key: 'analytics' },
      { path: '/chat', label: 'nav.chat', icon: 'chat', key: 'chat' },
    ],
  },
  {
    label: 'nav.sectionBehavior',
    items: [
      { path: '/rules', label: 'nav.rules', icon: 'rules', key: 'rules' },
      { path: '/claude-md', label: 'nav.claudeMd', icon: 'file', key: 'claudeMd' },
      { path: '/skills', label: 'nav.skills', icon: 'skills', key: 'skills' },
      { path: '/hooks', label: 'nav.hooks', icon: 'hooks', key: 'hooks' },
      { path: '/scripts', label: 'nav.scripts', icon: 'scripts', key: 'scripts' },
      { path: '/plugins', label: 'nav.plugins', icon: 'plugins', key: 'plugins' },
    ],
  },
  {
    label: 'nav.sectionIntegrations',
    items: [
      { path: '/mcp', label: 'nav.mcp', icon: 'mcp', key: 'mcp' },
      { path: '/permissions', label: 'nav.permissions', icon: 'permissions', key: 'permissions' },
      { path: '/env', label: 'nav.env', icon: 'env', key: 'env' },
      { path: '/projects', label: 'nav.projects', icon: 'folder', key: 'projects' },
    ],
  },
  {
    label: 'nav.sectionApp',
    items: [
      { path: '/groups', label: 'nav.groups', icon: 'groups', key: 'groups' },
      { path: '/history', label: 'nav.history', icon: 'history', key: 'history' },
      { path: '/settings', label: 'nav.settings', icon: 'settings', key: 'settings' },
      { path: '/help', label: 'nav.help', icon: 'help', key: 'help' },
    ],
  },
];

/** Плоский список всех разделов — для палитры и горячих клавиш. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);
