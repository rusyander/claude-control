import type { IntegrationLink } from '@agentdeck/contracts';

/**
 * Пустая ли привязка. Отсутствующая и «привязка, из которой всё стёрли» — одно
 * и то же состояние для человека, и показывать её строкой не за что.
 */
export function isLinkEmpty(link: IntegrationLink | undefined): boolean {
  if (!link) return true;
  return !(
    link.jiraProjectKey ||
    link.jiraIssueKey ||
    link.confluencePageId ||
    link.forgeRepo ||
    link.note
  );
}
