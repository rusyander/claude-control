import type { AtlassianSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

export function confluencePageUrl(
  atlassian: AtlassianSettings,
  pageId: string | undefined,
): string {
  if (!pageId) return '';
  const own = trimSlash(atlassian.confluenceUrl);
  const base = trimSlash(atlassian.baseUrl);
  if (!own && !base) return '';
  const root = own || (atlassian.deployment === 'server' ? base : `${base}/wiki`);
  return `${root}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}
