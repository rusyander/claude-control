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

/** То же для имени npm-пакета: занятое имя, затем непригодное для конфига. */
export function packageError(
  duplicate: boolean,
  invalid: boolean,
  t: (key: string) => string,
): string | undefined {
  if (duplicate) return t('providerPlugins.packages.duplicate');
  if (invalid) return t('providerPlugins.packages.invalid');
  return undefined;
}
