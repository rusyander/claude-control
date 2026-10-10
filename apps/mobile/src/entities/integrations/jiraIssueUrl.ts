import type { AtlassianSiteSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

export function jiraIssueUrl(jira: AtlassianSiteSettings, key: string | undefined): string {
  if (!jira.baseUrl || !key) return '';
  return `${trimSlash(jira.baseUrl)}/browse/${encodeURIComponent(key)}`;
}
