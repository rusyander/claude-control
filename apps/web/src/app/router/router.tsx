import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { MainLayout } from '@app/layouts/MainLayout/MainLayout';
import { OverviewPage } from '@pages/Overview/OverviewPage';
import { AnalyticsPage } from '@pages/Analytics/AnalyticsPage';
import { RulesPage } from '@pages/Rules/RulesPage';
import { ClaudeMdPage } from '@pages/ClaudeMd/ClaudeMdPage';
import { HooksPage } from '@pages/Hooks/HooksPage';
import { SkillsPage } from '@pages/Skills/SkillsPage';
import { ScriptsPage } from '@pages/Scripts/ScriptsPage';
import { ChatPage } from '@pages/Chat/ChatPage';
import { PluginsPage } from '@pages/Plugins/PluginsPage';
import { McpPage } from '@pages/Mcp/McpPage';
import { PermissionsPage } from '@pages/Permissions/PermissionsPage';
import { EnvPage } from '@pages/Env/EnvPage';
import { ProjectsPage } from '@pages/Projects/ProjectsPage';
import { GroupsPage } from '@pages/Groups/GroupsPage';
import { HistoryPage } from '@pages/History/HistoryPage';
import { SettingsPage } from '@pages/Settings/SettingsPage';
import { HelpPage } from '@pages/Help/HelpPage';
import { SearchPage } from '@pages/Search/SearchPage';

const rootRoute = createRootRoute({ component: MainLayout });

/**
 * Адрес открытого элемента.
 *
 * `?id=…` — единый способ сослаться на что угодно: разговор, правило, скилл,
 * хук, сервер. Открытие элемента дописывает id в адрес, а переход по такому
 * адресу открывает элемент — ссылкой можно поделиться и вернуться к ней позже.
 *
 * `?topic=…` — раздел справки. Тем же способом: ссылка на объяснение
 * конкретного раздела открывается сразу на нужном документе.
 */
function validateSearch(search: Record<string, unknown>): {
  id?: string;
  topic?: string;
  create?: boolean;
} {
  return {
    ...(typeof search.id === 'string' && search.id ? { id: search.id } : {}),
    ...(typeof search.topic === 'string' && search.topic ? { topic: search.topic } : {}),
    // `?create=1` — быстрое действие «Добавить» с обзора: раздел открывает свою
    // форму создания (см. useCreateParam). Держим булевым флагом, а не строкой.
    ...(search.create ? { create: true } : {}),
  };
}

/** Маршруты объявлены кодом: страниц немного, генератор файловых роутов избыточен. */
const routes = [
  { path: '/', component: OverviewPage },
  { path: '/search', component: SearchPage },
  { path: '/analytics', component: AnalyticsPage },
  { path: '/chat', component: ChatPage },
  { path: '/rules', component: RulesPage },
  { path: '/claude-md', component: ClaudeMdPage },
  { path: '/hooks', component: HooksPage },
  { path: '/skills', component: SkillsPage },
  { path: '/scripts', component: ScriptsPage },
  { path: '/plugins', component: PluginsPage },
  { path: '/mcp', component: McpPage },
  { path: '/permissions', component: PermissionsPage },
  { path: '/env', component: EnvPage },
  { path: '/projects', component: ProjectsPage },
  { path: '/groups', component: GroupsPage },
  { path: '/history', component: HistoryPage },
  { path: '/settings', component: SettingsPage },
  { path: '/help', component: HelpPage },
].map((route) => createRoute({ getParentRoute: () => rootRoute, validateSearch, ...route }));

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
