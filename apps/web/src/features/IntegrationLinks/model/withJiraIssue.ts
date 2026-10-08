import type { IntegrationLink, JiraIssue } from '@agentdeck/contracts';

export function withJiraIssue(link: IntegrationLink, issue: JiraIssue): IntegrationLink {
  return { ...link, jiraIssueKey: issue.key, jiraIssueTitle: issue.summary };
}
