/**
 * Ошибка поля пути правила: сначала занятый путь, потом выход за каталог.
 * Ничего не нарушено — ошибки нет вовсе.
 */
export function rulePathError(
  duplicate: boolean,
  unsafe: boolean,
  t: (key: string) => string,
): string | undefined {
  if (duplicate) return t('providerRules.duplicate');
  if (unsafe) return t('providerRules.unsafePath');
  return undefined;
}
