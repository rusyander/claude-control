import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { MainLayout } from '@app/layouts/MainLayout/MainLayout';
import { OverviewPage } from '@pages/Overview/OverviewPage';
import { AnalyticsPage } from '@pages/Analytics/AnalyticsPage';
import { RulesPage } from '@pages/Rules/RulesPage';
import { InstructionsSection } from '@pages/ClaudeMd/InstructionsSection';
import { HooksSection } from '@pages/Hooks/HooksSection';
import { SkillsSection } from '@pages/Skills/SkillsSection';
import { CommandsPage } from '@pages/Commands/CommandsPage';
import { ScriptsPage } from '@pages/Scripts/ScriptsPage';
import { ChatSection } from '@pages/Chat/ChatSection';
import { PluginsSection } from '@pages/Plugins/PluginsSection';
import { McpSection } from '@pages/Mcp/McpSection';
import { PermissionsSection } from '@pages/Permissions/PermissionsSection';
import { EnvSection } from '@pages/Env/EnvSection';
import { ProjectsPage } from '@pages/Projects/ProjectsPage';
import { GroupsPage } from '@pages/Groups/GroupsPage';
import { HistoryPage } from '@pages/History/HistoryPage';
import { SettingsPage } from '@pages/Settings/SettingsPage';
import { DlpPage } from '@pages/Dlp/DlpPage';
import { ProviderComparePage } from '@pages/ProviderCompare/ProviderComparePage';
import { HelpPage } from '@pages/Help/HelpPage';
import { SearchPage } from '@pages/Search/SearchPage';
import { gated } from './gated';
import { validateSearch } from './validateSearch';

const rootRoute = createRootRoute({ component: MainLayout });

/** Маршруты объявлены кодом: страниц немного, генератор файловых роутов избыточен. */
const routes = [
  // Панель-level разделы — без гейта: видны и работают при любом провайдере.
  { path: '/', component: OverviewPage },
  { path: '/search', component: SearchPage },
  { path: '/groups', component: GroupsPage },
  { path: '/history', component: HistoryPage },
  { path: '/settings', component: SettingsPage },
  { path: '/dlp', component: DlpPage },
  { path: '/compare', component: ProviderComparePage },
  { path: '/help', component: HelpPage },
  // Разделы провайдера — под гейтом возможностей (для Claude всё `ready`).
  { path: '/analytics', component: gated('analytics', AnalyticsPage) },
  { path: '/chat', component: gated('chat', ChatSection) },
  { path: '/rules', component: gated('rules', RulesPage) },
  { path: '/claude-md', component: gated('globalInstructions', InstructionsSection) },
  { path: '/hooks', component: gated('hooks', HooksSection) },
  { path: '/skills', component: gated('skills', SkillsSection) },
  { path: '/commands', component: gated('commands', CommandsPage) },
  { path: '/scripts', component: gated('scripts', ScriptsPage) },
  { path: '/plugins', component: gated('plugins', PluginsSection) },
  { path: '/mcp', component: gated('mcp', McpSection) },
  { path: '/permissions', component: gated('permissions', PermissionsSection) },
  { path: '/env', component: gated('env', EnvSection) },
  { path: '/projects', component: gated('projects', ProjectsPage) },
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
