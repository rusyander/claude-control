/**
 * Ошибка поля имени файла плагина: сначала занятое имя, потом выход за каталог.
 * Ничего не нарушено — ошибки нет вовсе.
 */
export function fileError(
  duplicate: boolean,
  unsafe: boolean,
  t: (key: string) => string,
): string | undefined {
  if (duplicate) return t('providerPlugins.file.duplicate');
  if (unsafe) return t('providerPlugins.file.unsafePath');
  return undefined;
}
