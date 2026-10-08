import type { IntegrationLink } from '@agentdeck/contracts';

/**
 * Снять один выбранный объект. Заголовок уходит вместе с ключом: заголовок без
 * ключа — это строка, по которой уже никуда не перейти.
 */
export function withoutJiraIssue(link: IntegrationLink): IntegrationLink {
  const { jiraIssueKey: _key, jiraIssueTitle: _title, ...rest } = link;
  return rest;
}
