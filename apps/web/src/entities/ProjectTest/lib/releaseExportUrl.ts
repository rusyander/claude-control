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
