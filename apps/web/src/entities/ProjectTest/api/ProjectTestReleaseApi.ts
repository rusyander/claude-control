import { useQuery } from '@tanstack/react-query';
import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Готовность вехи одним документом — только чтение.
 *
 * Документ собирается на лету и нигде не хранится: он обязан отвечать на
 * «отдаём или нет» СЕЙЧАС, а сохранённый устаревал бы на первом же прогоне и
 * врал бы ровно там, где на него смотрят.
 *
 * Запрос идёт, только когда веху выбрали: за требованиями сервер ходит в Jira,
 * и платить этим за каждый показ отчёта незачем.
 */
export function useTestRelease(path: string | undefined, release: string | undefined) {
  return useQuery({
    queryKey: testKeys.release(path, release),
    queryFn: async () => {
      const { data } = await apiClient.get<{
        releases: string[];
        document?: ProjectTestReleaseDocument;
      }>('/project-tests/release', { params: { path, release } });
      return data;
    },
    enabled: Boolean(path) && Boolean(release),
  });
}

/** Что документ отдаёт файлом: markdown в MR, HTML — когда печатать нечем. */
export type ReleaseExportFormat = 'md' | 'html' | 'pdf';

/**
 * Адрес документа файлом — обычная ссылка, а не запрос из кода: браузер сам
 * покажет диалог сохранения с именем из `Content-Disposition`.
 *
 * PDF живёт отдельным маршрутом, а не форматом выгрузки: печать асинхронная и
 * может честно ответить «нечем печатать» (501 с именем того, что поставить).
 */
export function releaseExportUrl(
  path: string | undefined,
  release: string,
  format: ReleaseExportFormat,
): string {
  if (format === 'pdf') {
    const print = new URLSearchParams({ path: path ?? '', release });
    return `/api/project-tests/release/pdf?${print.toString()}`;
  }
  const query = new URLSearchParams({ path: path ?? '', release, format });
  return `/api/project-tests/release/export?${query.toString()}`;
}
