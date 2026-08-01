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
import { ProviderComparePage } from '@pages/ProviderCompare/ProviderComparePage';
import { HelpPage } from '@pages/Help/HelpPage';
import { SearchPage } from '@pages/Search/SearchPage';
import type { Capability } from '@claude-control/contracts';
import type { ComponentType, ReactElement } from 'react';
import { RouteGate } from './RouteGate';

const rootRoute = createRootRoute({ component: MainLayout });

/**
 * Обернуть страницу гейтом возможности провайдера: у активного провайдера раздел
 * либо работает (страница), либо «в разработке»/недоступен (заглушка). Для
 * Claude гейт прозрачен — страница показывается как прежде.
 */
function gated(capability: Capability, Page: ComponentType) {
  return function GatedRoute(): ReactElement {
    return (
      <RouteGate capability={capability}>
        <Page />
      </RouteGate>
    );
  };
}

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
  // Панель-level разделы — без гейта: видны и работают при любом провайдере.
  { path: '/', component: OverviewPage },
  { path: '/search', component: SearchPage },
  { path: '/groups', component: GroupsPage },
  { path: '/history', component: HistoryPage },
  { path: '/settings', component: SettingsPage },
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
