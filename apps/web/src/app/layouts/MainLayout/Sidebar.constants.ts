import type { IconName } from '@shared/ui/icon';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  /** Ключ счётчика в сводке — не у всех разделов он есть. */
  key: string;
}

interface NavSection {
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
      { path: '/analytics', label: 'nav.analytics', icon: 'analytics', key: 'analytics' },
      { path: '/chat', label: 'nav.chat', icon: 'chat', key: 'chat' },
    ],
  },
  {
    label: 'nav.sectionBehavior',
    items: [
      { path: '/rules', label: 'nav.rules', icon: 'rules', key: 'rules' },
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
    ],
  },
  {
    label: 'nav.sectionApp',
    items: [
      { path: '/groups', label: 'nav.groups', icon: 'groups', key: 'groups' },
      { path: '/settings', label: 'nav.settings', icon: 'settings', key: 'settings' },
      { path: '/help', label: 'nav.help', icon: 'help', key: 'help' },
    ],
  },
];
