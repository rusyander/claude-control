import type { IntegrationLink, AtlassianSettings } from '@agentdeck/contracts';
import { confluencePageUrl } from './confluencePageUrl';
import { jiraIssueUrl } from './links';

/** Что показывать строкой: подпись объекта и адрес, если его удалось собрать. */
export interface LinkRow {
  kind: 'jiraIssue' | 'jiraProject' | 'confluencePage' | 'forgeRepo' | 'note';
  text: string;
  url: string;
}

/**
 * Привязка, разложенная в строки для показа. Порядок — от того, что человек
 * ищет чаще: задача, требования, куда заводить дефекты, свой репозиторий.
 */
export function linkRows(
  link: IntegrationLink | undefined,
  atlassian: AtlassianSettings,
): LinkRow[] {
  if (!link) return [];
  const rows: LinkRow[] = [];

  if (link.jiraIssueKey) {
    const title = link.jiraIssueTitle ? ` · ${link.jiraIssueTitle}` : '';
    rows.push({
      kind: 'jiraIssue',
      text: `${link.jiraIssueKey}${title}`,
      url: jiraIssueUrl(atlassian.baseUrl, link.jiraIssueKey),
    });
  }
  if (link.confluencePageId) {
    rows.push({
      kind: 'confluencePage',
      text: link.confluencePageTitle || link.confluencePageId,
      url: confluencePageUrl(atlassian, link.confluencePageId),
    });
  }
  if (link.jiraProjectKey) {
    rows.push({ kind: 'jiraProject', text: link.jiraProjectKey, url: '' });
  }
  if (link.forgeRepo) rows.push({ kind: 'forgeRepo', text: link.forgeRepo, url: '' });
  if (link.note) rows.push({ kind: 'note', text: link.note, url: '' });

  return rows;
}
