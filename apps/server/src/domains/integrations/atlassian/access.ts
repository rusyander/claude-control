import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { toAccess, type AtlassianAccess } from './client.ts';
import { readConfluenceToken, readIntegrations, requireConnected } from '../store/store.ts';

/**
 * Доступ к Atlassian из настроек и сохранённых токенов — их ДВА.
 *
 * Второй (Confluence) необязателен и добирается молча: у облака его нет вовсе,
 * а на своей установке без него Confluence отвечал 401 на рабочем ключе Jira.
 * Требуем по-прежнему только основной — иначе настроенная Jira перестала бы
 * работать у всех, кто вики не пользуется.
 *
 * Здесь, в домене, а не у маршрутов: тикеты разделения заводит домен чата, и
 * дотягиваться ему до слоя маршрутов нельзя (`pnpm depcruise`).
 */
export function atlassianAccessFrom(store: AppStore, appDataDir: string): AtlassianAccess {
  const token = requireConnected(store, appDataDir, 'atlassian', 'Atlassian');
  return toAccess(readIntegrations(store).atlassian, token, readConfluenceToken(appDataDir) ?? '');
}
