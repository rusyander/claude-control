import type { SplitTicketTarget } from '@agentdeck/contracts/split-ticket-batch';
import { codeOf } from '../../../lib/server-text/server-text.ts';
import type { BatchTracker } from './publish.ts';

/**
 * Куда заводить из окна «Разобрать…»: подключённая Jira, её проекты и типы
 * задач. По умолчанию — всегда подключённая установка; проект — привязка
 * проекта панели, иначе последний выбранный человеком, иначе первый в списке.
 */
export interface TicketTargetTracker extends BatchTracker {
  connected: () => boolean;
  site: () => string;
  /** Проект Jira, привязанный к проекту панели; нет — `undefined`. */
  bound: (projectPath: string) => string | undefined;
  projects: () => Promise<{ key: string; name: string }[]>;
  issueTypes: (projectKey: string) => Promise<string[]>;
}

/** Bug, если есть; иначе Task; иначе первый. Без регистра: «bug» у своей установки бывает. */
export function defaultIssueType(types: readonly string[]): string | undefined {
  const find = (name: string) => types.find((type) => type.toLowerCase() === name);
  return find('bug') ?? find('task') ?? types[0];
}

/** Выбор человека в окне, иначе привязка, иначе последний, иначе первый. */
function pickProject(
  has: (key: string | undefined) => key is string,
  bound: string | undefined,
  options: { project?: string; last?: string },
  first: string | undefined,
): { key?: string; from?: SplitTicketTarget['projectFrom'] } {
  if (has(options.project)) return { key: options.project };
  if (has(bound)) return { key: bound, from: 'bound' };
  if (has(options.last)) return { key: options.last, from: 'last' };
  return first ? { key: first, from: 'first' } : {};
}

export async function ticketTarget(
  tracker: TicketTargetTracker,
  projectPath: string,
  options: { project?: string; last?: string },
): Promise<SplitTicketTarget> {
  if (!tracker.connected()) return { connected: false, projects: [], issueTypes: [] };
  const site = tracker.site();
  try {
    const projects = await tracker.projects();
    const has = (key: string | undefined): key is string =>
      Boolean(key) && projects.some((project) => project.key === key);
    const picked = pickProject(has, tracker.bound(projectPath), options, projects[0]?.key);
    const issueTypes = picked.key ? await tracker.issueTypes(picked.key) : [];
    const issueType = defaultIssueType(issueTypes);
    return {
      connected: true,
      site,
      projects,
      ...(picked.key ? { projectKey: picked.key } : {}),
      ...(picked.from ? { projectFrom: picked.from } : {}),
      issueTypes,
      ...(issueType ? { issueType } : {}),
    };
  } catch (error) {
    return { connected: true, site, projects: [], issueTypes: [], ...codeOf(error) };
  }
}
