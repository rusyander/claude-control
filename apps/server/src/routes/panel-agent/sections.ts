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
}

export const PANEL_SECTIONS: readonly PanelSection[] = [
  { route: '/', title: 'Overview', description: 'Summary of the whole configuration' },
  { route: '/search', title: 'Search', description: 'Search across rules, skills, hooks, MCP' },
  { route: '/groups', title: 'Groups', description: 'Groups of rules/skills/MCP toggled together' },
  { route: '/history', title: 'History', description: 'Backups of edited files, restore' },
  { route: '/settings', title: 'Settings', description: 'Panel settings, remote access, access' },
  { route: '/dlp', title: 'Data protection', description: 'Local DLP proxy and its rules' },
  { route: '/platform', title: 'Contour', description: 'Corporate model contours and gateway' },
  { route: '/compare', title: 'Compare CLIs', description: 'Side-by-side CLI provider comparison' },
  { route: '/help', title: 'Help', description: 'In-panel documentation' },
  { route: '/analytics', title: 'Analytics', description: 'Usage and cost from transcripts' },
  { route: '/chat', title: 'Chat', description: 'CLI chats per project, runs, splits' },
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
  { route: '/projects', title: 'Projects', description: 'Project registry and project configs' },
  { route: '/tests', title: 'Testing', description: 'QA workspace: cases, runs, coverage' },
];

/** Пути разделов кортежем — для `z.enum`: модель видит допустимые значения в схеме. */
export function sectionRoutes(): [string, ...string[]] {
  const [first, ...rest] = PANEL_SECTIONS.map((section) => section.route);
  if (first === undefined) throw new Error('PANEL_SECTIONS пуст');
  return [first, ...rest];
}
