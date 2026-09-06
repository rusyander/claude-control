import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { MainLayout } from '@app/layouts/MainLayout/MainLayout';
import { OverviewPage } from '@pages/Overview/OverviewPage';
import { ChatSection } from '@pages/Chat/ChatSection';
import { SkeletonList } from '@shared/ui/skeleton';
import { i18n, loadHelp, toLanguage } from '@shared/config/i18n';
import { gated } from './gated';
import { validateSearch } from './validateSearch';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';

/*
 * Обзор и чат — в главном чанке: с них панель открывается. Остальные разделы
 * — свои чанки, качаются при первом переходе или заранее, при наведении на
 * ссылку (`defaultPreload: 'intent'`). Иначе один бандл на 3 МБ грузился
 * целиком ради любого раздела — с телефона по Tailscale это секунды.
 */
const SearchPage = lazyRouteComponent(() => import('@pages/Search/SearchPage'), 'SearchPage');
const GroupsPage = lazyRouteComponent(() => import('@pages/Groups/GroupsPage'), 'GroupsPage');
const HistoryPage = lazyRouteComponent(() => import('@pages/History/HistoryPage'), 'HistoryPage');
const SettingsPage = lazyRouteComponent(
  () => import('@pages/Settings/SettingsPage'),
  'SettingsPage',
);
const DlpPage = lazyRouteComponent(() => import('@pages/Dlp/DlpPage'), 'DlpPage');
const ProviderComparePage = lazyRouteComponent(
  () => import('@pages/ProviderCompare/ProviderComparePage'),
  'ProviderComparePage',
);
const HelpPage = lazyRouteComponent(() => import('@pages/Help/HelpPage'), 'HelpPage');
const AnalyticsPage = lazyRouteComponent(
  () => import('@pages/Analytics/AnalyticsPage'),
  'AnalyticsPage',
);
const RulesPage = lazyRouteComponent(() => import('@pages/Rules/RulesPage'), 'RulesPage');
const InstructionsSection = lazyRouteComponent(
  () => import('@pages/ClaudeMd/InstructionsSection'),
  'InstructionsSection',
);
const HooksSection = lazyRouteComponent(() => import('@pages/Hooks/HooksSection'), 'HooksSection');
const SkillsSection = lazyRouteComponent(
  () => import('@pages/Skills/SkillsSection'),
  'SkillsSection',
);
const CommandsPage = lazyRouteComponent(
  () => import('@pages/Commands/CommandsPage'),
  'CommandsPage',
);
const ScriptsPage = lazyRouteComponent(() => import('@pages/Scripts/ScriptsPage'), 'ScriptsPage');
const PluginsSection = lazyRouteComponent(
  () => import('@pages/Plugins/PluginsSection'),
  'PluginsSection',
);
const McpSection = lazyRouteComponent(() => import('@pages/Mcp/McpSection'), 'McpSection');
const PermissionsSection = lazyRouteComponent(
  () => import('@pages/Permissions/PermissionsSection'),
  'PermissionsSection',
);
const EnvSection = lazyRouteComponent(() => import('@pages/Env/EnvSection'), 'EnvSection');
const ProjectsPage = lazyRouteComponent(
  () => import('@pages/Projects/ProjectsPage'),
  'ProjectsPage',
);

/** Чанк раздела едет дольше секунды — скелет вместо застывшей предыдущей страницы. */
function RoutePending() {
  return <SkeletonList rows={4} withActions={false} />;
}

// Свои «не найдено» и «упало» внутри макета: дефолты роутера — голые английские
// «Not Found» и «Something went wrong!» на месте всей панели, без навигации.
const rootRoute = createRootRoute({
  component: MainLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteErrorPage,
});

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
  // Словарь справки — отдельный чанк; лоадер дотягивает его до первого
  // рендера, поэтому страница ни разу не видит «help.…» вместо текста.
  { path: '/help', component: HelpPage, loader: () => loadHelp(toLanguage(i18n.language)) },
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
  // Данные и чанк раздела подгружаются заранее при наведении на ссылку.
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  // Сбой раздела ловится на его маршруте — макет и боковая навигация живы.
  defaultErrorComponent: RouteErrorPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
