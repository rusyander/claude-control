import type { IntegrationLink, IntegrationLinks } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import { WORKTREES_DIR_SUFFIX } from '../project-git/worktrees.ts';
import { invalidField } from './errors.ts';

/**
 * Привязка проекта к внешнему миру: какой проект Jira, какая задача, какая
 * страница Confluence.
 *
 * Это единственное, чего агент не может узнать сам: в репозитории нигде не
 * написано, что работа относится к тикету PRJ-1234, а требования лежат на
 * такой-то странице. Человек говорит это один раз, и дальше строку получают все
 * — и панель, и агент через свой MCP.
 */

export function readLinks(store: AppStore, path: string): IntegrationLinks {
  return store.getIntegrationLinks(requirePath(path));
}

export function writeLink(
  store: AppStore,
  path: string,
  groupId: string | undefined,
  link: IntegrationLink,
): IntegrationLinks {
  return store.setIntegrationLink(requirePath(path), groupId, link);
}

export function dropLink(
  store: AppStore,
  path: string,
  groupId: string | undefined,
): IntegrationLinks {
  return store.removeIntegrationLink(requirePath(path), groupId);
}

/**
 * Привязка, действующая для рабочей папки прогона: сначала своя группа, потом
 * сам проект. Копия ветки (`<репозиторий>-worktrees/<ветка>`) — тот же проект:
 * тикет и требования от смены ветки не меняются.
 */
export function linkForCwd(
  store: AppStore,
  cwd: string,
  groupId?: string,
): { link: IntegrationLink; projectPath: string } | undefined {
  const target = normalizeProjectPath(cwd);
  if (!target) return undefined;

  for (const [projectPath, links] of Object.entries(store.getAllIntegrationLinks())) {
    const inside =
      target === projectPath ||
      target.startsWith(`${projectPath}/`) ||
      target.startsWith(`${projectPath}${WORKTREES_DIR_SUFFIX}/`);
    if (!inside) continue;

    const group = groupId ? links.groups[groupId] : undefined;
    const link = { ...links.project, ...group };
    if (Object.keys(link).length === 0) continue;
    return { link, projectPath };
  }
  return undefined;
}

/**
 * Строка контекста для агента: то, чего он не может выяснить сам.
 *
 * Пусто, если человек ничего не привязал, — выдумывать тикет нельзя, а пустая
 * строка в задании безобиднее ложной.
 */
export function describeLink(link: IntegrationLink): string {
  const parts = [
    link.jiraIssueKey
      ? `задача ${link.jiraIssueKey}${link.jiraIssueTitle ? ` — ${link.jiraIssueTitle}` : ''}`
      : '',
    link.jiraProjectKey ? `проект Jira ${link.jiraProjectKey}` : '',
    link.confluencePageId
      ? `страница Confluence ${link.confluencePageId}${
          link.confluencePageTitle ? ` — ${link.confluencePageTitle}` : ''
        }`
      : '',
    link.forgeRepo ? `репозиторий ${link.forgeRepo}` : '',
    link.note ?? '',
  ].filter(Boolean);
  return parts.join('; ');
}

function requirePath(path: string): string {
  const value = String(path ?? '').trim();
  if (!value)
    throw invalidField('path', 'не указан каталог проекта', 'request-project-dir-missing', {
      field: 'path',
    });
  return value;
}
