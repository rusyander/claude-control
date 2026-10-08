import type { MediaDeckFormat } from '@agentdeck/contracts';

/**
 * Адрес файла презентации. Ссылкой, а не запросом: HTML открывается в своей
 * вкладке целым экраном (колоду так и смотрят), PPTX сохраняется средствами
 * системы, а PDF печатается сервером при первом спросе — браузер покажет
 * ожидание сам, и нести это через наш слой данных незачем.
 */
export function mediaDeckUrl(id: string, format: MediaDeckFormat): string {
  return `/api/media/decks/${encodeURIComponent(id)}/${format}`;
}
