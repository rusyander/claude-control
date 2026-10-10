import type { AtlassianSiteSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

/**
 * Ссылка на страницу Confluence по её id. Адрес вики — у своей интеграции;
 * облако держит её под `/wiki` сайта, и адрес сайта без него достраивается так
 * же, как на сервере (`toConfluenceAccess`).
 */
export function confluencePageUrl(
  confluence: AtlassianSiteSettings,
  pageId: string | undefined,
): string {
  if (!pageId) return '';
  const base = trimSlash(confluence.baseUrl);
  if (!base) return '';
  const cloud = confluence.deployment
    ? confluence.deployment === 'cloud'
    : Boolean(confluence.email.trim());
  const root = cloud && !/\/wiki$/.test(base) ? `${base}/wiki` : base;
  return `${root}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}
