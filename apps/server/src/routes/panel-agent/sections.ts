/**
 * Разделы панели глазами агента: путь роутера веба и короткое английское
 * описание — модель читает его, выбирая, куда открыть страницу.
 *
 * Список ведётся руками, потому что сервер не может импортировать роутер веба
 * (это React и другой слой). Разойтись молча ему не дают: `sections.test.ts`
 * читает `apps/web/src/app/router/router.tsx` и краснеет на любом пути, который
 * есть там и отсутствует здесь, и наоборот.
 */
export interface PanelSection {
  route: string;
  title: string;
  description: string;
  /**
   * Ключи вкладок раздела — значение `focus` у open_page (веб кладёт его в
   * `?tab=`). Без них «открой настройки моделей» открывало общую вкладку.
   * Сверяются с вебом в `sections.test.ts`.
   */
  tabs?: readonly string[];
}

export const PANEL_SECTIONS: readonly PanelSection[] = [
  { route: '/', title: 'Overview', description: 'Summary of the whole configuration' },
  { route: '/search', title: 'Search', description: 'Search across rules, skills, hooks, MCP' },
  {
    route: '/groups',
    title: 'Groups',
    description: 'Groups of rules/skills/MCP toggled together, with a run «Path» and skill knobs',
  },
  { route: '/history', title: 'History', description: 'Backups of edited files, restore' },
  {
    route: '/settings',
    title: 'Settings',
    description:
      'Panel settings by tab; open_page focus = tab key: general (theme, language), access (remote, token), ' +
      'providers (active CLI), models (endpoint profiles, chat model), prompts, groups (split groups), ' +
      'globalLayer (panel vs ~/.claude copies of one mechanism), ' +
      'integrations (tracker, messenger, webhook), spend, safety (backups, file watch), transfer',
    tabs: [
      'general',
      'access',
      'providers',
      'models',
      'prompts',
      'groups',
      'globalLayer',
      'integrations',
      'spend',
      'safety',
      'transfer',
    ],
  },
  { route: '/dlp', title: 'Data protection', description: 'Local DLP proxy and its rules' },
  {
    route: '/local-models',
    title: 'Local models',
    description: 'Models on this machine: runtime, downloads, benchmark, connection to CLIs',
  },
  {
    route: '/kit',
    title: 'Panel kit',
    description: 'Built-in skills, pipeline commands, rules and hooks; per-CLI kit mode',
  },
  { route: '/platform', title: 'Contour', description: 'Corporate model contours and gateway' },
  { route: '/compare', title: 'Compare CLIs', description: 'Side-by-side CLI provider comparison' },
  {
    route: '/portability',
    title: 'Environment passport',
    description: 'What one CLI actually has configured: items and named skips',
  },
  { route: '/help', title: 'Help', description: 'In-panel documentation' },
  { route: '/analytics', title: 'Analytics', description: 'Usage and cost from transcripts' },
  {
    route: '/chat',
    title: 'Chat',
    description: 'CLI chats per project, runs, splits; open_page focus = chat id to open that chat',
  },
  { route: '/rules', title: 'Rules', description: 'Rule files of the active CLI' },
  { route: '/claude-md', title: 'Global instructions', description: 'User-level CLAUDE.md' },
  { route: '/hooks', title: 'Hooks', description: 'CLI hooks' },
  { route: '/skills', title: 'Skills', description: 'CLI skills' },
  { route: '/commands', title: 'Commands', description: 'Slash commands' },
  { route: '/scripts', title: 'Scripts', description: 'Scripts under the config dir' },
  { route: '/plugins', title: 'Plugins', description: 'CLI plugins' },
  { route: '/mcp', title: 'MCP', description: 'MCP servers and their health' },
  { route: '/permissions', title: 'Permissions', description: 'Allow/deny permission rules' },
  { route: '/env', title: 'Environment', description: 'Environment variables of the CLI' },
  {
    route: '/projects',
    title: 'Projects',
    description:
      'Project registry and project configs; open_page focus = project id from list_projects (not a path)',
  },
  {
    route: '/tests',
    title: 'Testing',
    description:
      'QA workspace; open_page focus = tab key: library (cases, groups), plans, runs, report, coverage',
    tabs: ['library', 'plans', 'runs', 'report', 'coverage'],
  },
];

/** Пути разделов кортежем — для `z.enum`: модель видит допустимые значения в схеме. */
export function sectionRoutes(): [string, ...string[]] {
  const [first, ...rest] = PANEL_SECTIONS.map((section) => section.route);
  if (first === undefined) throw new Error('PANEL_SECTIONS пуст');
  return [first, ...rest];
}
