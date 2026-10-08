/**
 * Адрес выгрузки — обычная ссылка, а не запрос из кода: браузер сам покажет
 * диалог сохранения с именем файла из `Content-Disposition`, а собранный в
 * памяти blob пришлось бы ещё и освобождать.
 */
export function exportUrl(
  path: string | undefined,
  groupId: string,
  format: 'csv' | 'md' | 'xlsx',
): string {
  const query = new URLSearchParams({ path: path ?? '', groupId, format });
  return `/api/project-tests/export?${query.toString()}`;
}
