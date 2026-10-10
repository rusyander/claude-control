import type { AtlassianSiteSettings } from '@agentdeck/contracts';
import { trimSlash } from './trimSlash';

/**
 * Адрес вики — у своей интеграции; облако держит её под `/wiki` сайта. Вид не
 * записан — облако узнаётся по почте: на своей установке её не вводят.
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
