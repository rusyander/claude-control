import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { MainLayout } from '@app/layouts/MainLayout/MainLayout';
import { OverviewPage } from '@pages/Overview/OverviewPage/OverviewPage';
import { ChatSection } from '@pages/Chat/ChatSection/ChatSection';
import { i18n, loadHelp, toLanguage } from '@shared/config/i18n';
import { gated } from './gated';
import { validateSearch } from './validateSearch';
import { NotFoundPage } from './NotFoundPage/NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage/RouteErrorPage';
import { RoutePending } from './RoutePending/RoutePending';

/*
 * Обзор и чат — в главном чанке: с них панель открывается. Остальные разделы
 * — свои чанки, качаются при первом переходе или заранее, при наведении на
 * ссылку (`defaultPreload: 'intent'`). Иначе один бандл на 3 МБ грузился
 * целиком ради любого раздела — с телефона по Tailscale это секунды.
 */
const SearchPage = lazyRouteComponent(() => import('@pages/Search/SearchPage'), 'SearchPage');
const GroupsPage = lazyRouteComponent(
  () => import('@pages/Groups/GroupsPage/GroupsPage'),
  'GroupsPage',
);
const HistoryPage = lazyRouteComponent(
  () => import('@pages/History/HistoryPage/HistoryPage'),
  'HistoryPage',
);
const SettingsPage = lazyRouteComponent(
  () => import('@pages/Settings/SettingsPage/SettingsPage'),
  'SettingsPage',
);
const DlpPage = lazyRouteComponent(() => import('@pages/Dlp/DlpPage/DlpPage'), 'DlpPage');
const PlatformPage = lazyRouteComponent(
  () => import('@pages/Platform/PlatformPage/PlatformPage'),
  'PlatformPage',
);
const KitPage = lazyRouteComponent(() => import('@pages/Kit/KitPage/KitPage'), 'KitPage');
const LocalModelsPage = lazyRouteComponent(
  () => import('@pages/LocalModels/LocalModelsPage/LocalModelsPage'),
  'LocalModelsPage',
);
const ProviderComparePage = lazyRouteComponent(
  () => import('@pages/ProviderCompare/ProviderComparePage/ProviderComparePage'),
  'ProviderComparePage',
);
const PortabilityPage = lazyRouteComponent(
  () => import('@pages/Portability/PortabilityPage/PortabilityPage'),
  'PortabilityPage',
);
const HelpPage = lazyRouteComponent(() => import('@pages/Help/HelpPage/HelpPage'), 'HelpPage');
const AnalyticsPage = lazyRouteComponent(
  () => import('@pages/Analytics/AnalyticsPage/AnalyticsPage'),
  'AnalyticsPage',
);
const RulesSection = lazyRouteComponent(
  () => import('@pages/Rules/RulesSection/RulesSection'),
  'RulesSection',
);
const InstructionsSection = lazyRouteComponent(
  () => import('@pages/ClaudeMd/InstructionsSection/InstructionsSection'),
  'InstructionsSection',
);
const HooksSection = lazyRouteComponent(
  () => import('@pages/Hooks/HooksSection/HooksSection'),
  'HooksSection',
);
const SkillsSection = lazyRouteComponent(
  () => import('@pages/Skills/SkillsSection/SkillsSection'),
  'SkillsSection',
);
const CommandsPage = lazyRouteComponent(
  () => import('@pages/Commands/CommandsPage/CommandsPage'),
  'CommandsPage',
);
const ScriptsPage = lazyRouteComponent(() => import('@pages/Scripts/ScriptsPage'), 'ScriptsPage');
const PluginsSection = lazyRouteComponent(
  () => import('@pages/Plugins/PluginsSection/PluginsSection'),
  'PluginsSection',
);
const McpSection = lazyRouteComponent(
  () => import('@pages/Mcp/McpSection/McpSection'),
  'McpSection',
);
const PermissionsSection = lazyRouteComponent(
  () => import('@pages/Permissions/PermissionsSection/PermissionsSection'),
  'PermissionsSection',
);
const EnvSection = lazyRouteComponent(
  () => import('@pages/Env/EnvSection/EnvSection'),
  'EnvSection',
);
const ProjectsPage = lazyRouteComponent(
  () => import('@pages/Projects/ProjectsPage/ProjectsPage'),
  'ProjectsPage',
);
const TestsPage = lazyRouteComponent(() => import('@pages/Tests/TestsPage/TestsPage'), 'TestsPage');

// Свои «не найдено» и «упало» внутри макета: дефолты роутера — голые английские
// «Not Found» и «Something went wrong!» на месте всей панели, без навигации.
const rootRoute = createRootRoute({
  component: MainLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteErrorPage,
});

/**
 * Режим раскладки раздела (MainLayout). По умолчанию страница растёт с
 * содержимым и прокручивается колонкой раздела — одна прокрутка на страницу.
 * `fill` — страница ровно в высоту колонки и сама держит свои прокрутки.
 */
const FILL = { layout: 'fill' } as const;

/** Маршруты объявлены кодом: страниц немного, генератор файловых роутов избыточен. */
const routes = [
  // Панель-level разделы — без гейта: видны и работают при любом провайдере.
  { path: '/', component: OverviewPage },
  { path: '/search', component: SearchPage },
  { path: '/groups', component: GroupsPage },
  { path: '/history', component: HistoryPage },
  { path: '/settings', component: SettingsPage },
  { path: '/dlp', component: DlpPage },
  { path: '/platform', component: PlatformPage },
  { path: '/local-models', component: LocalModelsPage },
  { path: '/kit', component: KitPage },
  { path: '/compare', component: ProviderComparePage },
  { path: '/portability', component: PortabilityPage },
  // Словарь справки — отдельный чанк; лоадер дотягивает его до первого
  // рендера, поэтому страница ни разу не видит «help.…» вместо текста.
  { path: '/help', component: HelpPage, loader: () => loadHelp(toLanguage(i18n.language)) },
  // Разделы провайдера — под гейтом возможностей (для Claude всё `ready`).
  { path: '/analytics', component: gated('analytics', AnalyticsPage) },
  // Чат сам держит свои прокрутки (лента, список разговоров): его обёртка — ровно
  // высота колонки раздела, а не растущая с содержимым страница.
  { path: '/chat', component: gated('chat', ChatSection), staticData: FILL },
  { path: '/rules', component: gated('rules', RulesSection) },
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
  // Тестирование живёт над реестром проектов и запускает прогоны через CLI,
  // поэтому гейтится той же возможностью, что и сам реестр.
  { path: '/tests', component: gated('projects', TestsPage), staticData: FILL },
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
  interface StaticDataRouteOption {
    /** См. `FILL`: страница сама держит свои прокрутки. */
    layout?: 'fill';
  }
}
