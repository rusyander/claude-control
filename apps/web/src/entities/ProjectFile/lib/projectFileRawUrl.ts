import { apiClient } from '@shared/api/client';

/**
 * Адрес файла для показа тегом: картинку и PDF браузер тянет сам.
 *
 * `mtimeMs` в адресе — не украшение: ответ отдаётся без кэша, но у самого тега
 * `img` кэш свой, и без смены адреса перезаписанная агентом картинка осталась
 * бы на экране прежней.
 */
export function projectFileRawUrl(path: string, file: string, mtimeMs: number): string {
  const query = new URLSearchParams({ path, file, v: String(Math.round(mtimeMs)) });
  return `${apiClient.defaults.baseURL}/project-files/raw?${query.toString()}`;
}
