import type { Capability } from '@claude-control/contracts';
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
  /**
   * К какой возможности провайдера привязан раздел. Задан — раздел гейтится по
   * статусу возможности активного провайдера (ready → работает, planned → «в
   * разработке», unsupported → скрыт). НЕ задан — раздел панель-level (Настройки,
   * История, Поиск, Обзор, Группы, Справка): виден всегда, от провайдера не
   * зависит.
   */
  capability?: Capability;
}

export interface NavSection {
  /** Ключ i18n подписи секции. */
  label: string;
  items: NavItem[];
}

/**
 * Навигация сгруппирована по смыслу: сначала то, что настраивает поведение
 * провайдера, затем доступы и окружение, затем сам инструмент. Панель-level
 * разделы (обзор, поиск, группы, история, настройки, справка) идут без
 * `capability` — они не зависят от выбранного провайдера.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'nav.sectionMain',
    items: [
      { path: '/', label: 'nav.overview', icon: 'overview', key: 'overview' },
      { path: '/search', label: 'nav.search', icon: 'search', key: 'search' },
      {
        path: '/analytics',
        label: 'nav.analytics',
        icon: 'analytics',
        key: 'analytics',
        capability: 'analytics',
      },
      { path: '/chat', label: 'nav.chat', icon: 'chat', key: 'chat', capability: 'chat' },
    ],
  },
  {
    label: 'nav.sectionBehavior',
    items: [
      { path: '/rules', label: 'nav.rules', icon: 'rules', key: 'rules', capability: 'rules' },
      {
        path: '/claude-md',
        label: 'nav.claudeMd',
        icon: 'file',
        key: 'claudeMd',
        capability: 'globalInstructions',
      },
      { path: '/skills', label: 'nav.skills', icon: 'skills', key: 'skills', capability: 'skills' },
      { path: '/hooks', label: 'nav.hooks', icon: 'hooks', key: 'hooks', capability: 'hooks' },
      {
        path: '/scripts',
        label: 'nav.scripts',
        icon: 'scripts',
        key: 'scripts',
        capability: 'scripts',
      },
      {
        path: '/plugins',
        label: 'nav.plugins',
        icon: 'plugins',
        key: 'plugins',
        capability: 'plugins',
      },
    ],
  },
  {
    label: 'nav.sectionIntegrations',
    items: [
      { path: '/mcp', label: 'nav.mcp', icon: 'mcp', key: 'mcp', capability: 'mcp' },
      {
        path: '/permissions',
        label: 'nav.permissions',
        icon: 'permissions',
        key: 'permissions',
        capability: 'permissions',
      },
      { path: '/env', label: 'nav.env', icon: 'env', key: 'env', capability: 'env' },
      {
        path: '/projects',
        label: 'nav.projects',
        icon: 'folder',
        key: 'projects',
        capability: 'projects',
      },
    ],
  },
  {
    label: 'nav.sectionApp',
    items: [
      { path: '/groups', label: 'nav.groups', icon: 'groups', key: 'groups' },
      { path: '/history', label: 'nav.history', icon: 'history', key: 'history' },
      { path: '/compare', label: 'nav.compare', icon: 'swap', key: 'compare' },
      { path: '/settings', label: 'nav.settings', icon: 'settings', key: 'settings' },
      { path: '/help', label: 'nav.help', icon: 'help', key: 'help' },
    ],
  },
];

/** Плоский список всех разделов — для палитры и горячих клавиш. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** Возможности, у которых есть раздел в навигации (у `sandbox` своего раздела нет). */
export const NAV_CAPABILITIES: Capability[] = [
  ...new Set(
    NAV_ITEMS.map((item) => item.capability).filter((capability): capability is Capability =>
      Boolean(capability),
    ),
  ),
];
