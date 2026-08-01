/**
 * Время правки скрипта целиком в локальном формате: у файлов каталога `hooks/`
 * важна не дата, а «когда именно», поэтому короткая дата из `@shared/lib/format`
 * тут не подходит.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
