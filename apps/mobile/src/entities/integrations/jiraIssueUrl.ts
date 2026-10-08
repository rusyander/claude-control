import type { AtlassianSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

export function jiraIssueUrl(atlassian: AtlassianSettings, key: string | undefined): string {
  if (!atlassian.baseUrl || !key) return '';
  return `${trimSlash(atlassian.baseUrl)}/browse/${encodeURIComponent(key)}`;
}
