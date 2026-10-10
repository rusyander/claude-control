import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { toAccess, toConfluenceAccess, type AtlassianAccess } from './client.ts';
import { readIntegrations, requireConnected } from '../store/store.ts';

/**
 * Доступ к Jira и к Confluence из настроек и сохранённых ключей — у каждой
 * системы свои (владелец 10.10.2026): отключённая Confluence не мешает Jira, и
 * наоборот, а на своей установке ключ одной другой отклоняется с 401.
 *
 * Здесь, в домене, а не у маршрутов: тикеты разделения заводит домен чата, и
 * дотягиваться ему до слоя маршрутов нельзя (`pnpm depcruise`).
 */
export function jiraAccessFrom(store: AppStore, appDataDir: string): AtlassianAccess {
  const token = requireConnected(store, appDataDir, 'jira');
  return toAccess(readIntegrations(store).jira, token);
}

export function confluenceAccessFrom(store: AppStore, appDataDir: string): AtlassianAccess {
  const token = requireConnected(store, appDataDir, 'confluence');
  return toConfluenceAccess(readIntegrations(store).confluence, token);
}
