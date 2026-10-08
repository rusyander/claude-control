import type { AtlassianSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

/** Ссылка на страницу Confluence по её id. */
export function confluencePageUrl(
  atlassian: AtlassianSettings,
  pageId: string | undefined,
): string {
  if (!pageId) return '';
  const own = trimSlash(atlassian.confluenceUrl);
  const base = trimSlash(atlassian.baseUrl);
  if (!own && !base) return '';
  // Свой адрес Confluence задан — он уже указывает на корень, `/wiki` не нужен.
  const root = own || (atlassian.deployment === 'server' ? base : `${base}/wiki`);
  return `${root}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}
