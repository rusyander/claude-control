import type { QueryClient } from '@tanstack/react-query';

/**
 * Данные прежней панели — прочь со всех экранов сразу. `clear()` тут не годится: он
 * выкидывает запросы из кэша, но смонтированные экраны о том не узнают и держат старое,
 * пока сами не перезапросятся. `resetQueries` возвращает каждый запрос к началу и
 * оповещает подписчиков; включённые тут же перезапрашиваются уже у новой панели.
 */
export function forgetPanelData(client: QueryClient): Promise<void> {
  return client.resetQueries();
}
