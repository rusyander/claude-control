import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { MainLayout } from '@app/layouts/MainLayout/MainLayout';
import { OverviewPage } from '@pages/Overview/OverviewPage';
import { AnalyticsPage } from '@pages/Analytics/AnalyticsPage';
import { RulesPage } from '@pages/Rules/RulesPage';
import { HooksPage } from '@pages/Hooks/HooksPage';
import { SkillsPage } from '@pages/Skills/SkillsPage';
import { ScriptsPage } from '@pages/Scripts/ScriptsPage';
import { ChatPage } from '@pages/Chat/ChatPage';
import { PluginsPage } from '@pages/Plugins/PluginsPage';
import { McpPage } from '@pages/Mcp/McpPage';
import { PermissionsPage } from '@pages/Permissions/PermissionsPage';
import { EnvPage } from '@pages/Env/EnvPage';
import { GroupsPage } from '@pages/Groups/GroupsPage';
import { SettingsPage } from '@pages/Settings/SettingsPage';
import { HelpPage } from '@pages/Help/HelpPage';

const rootRoute = createRootRoute({ component: MainLayout });

/** Маршруты объявлены кодом: страниц немного, генератор файловых роутов избыточен. */
const routes = [
  { path: '/', component: OverviewPage },
  { path: '/analytics', component: AnalyticsPage },
  { path: '/chat', component: ChatPage },
  { path: '/rules', component: RulesPage },
  { path: '/hooks', component: HooksPage },
  { path: '/skills', component: SkillsPage },
  { path: '/scripts', component: ScriptsPage },
  { path: '/plugins', component: PluginsPage },
  { path: '/mcp', component: McpPage },
  { path: '/permissions', component: PermissionsPage },
  { path: '/env', component: EnvPage },
  { path: '/groups', component: GroupsPage },
  { path: '/settings', component: SettingsPage },
  { path: '/help', component: HelpPage },
].map((route) => createRoute({ getParentRoute: () => rootRoute, ...route }));

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  // Данные страницы подгружаются заранее при наведении на ссылку.
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
