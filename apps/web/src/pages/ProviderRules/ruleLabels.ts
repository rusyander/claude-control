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

/**
 * Ключ подписи кнопки строки правила: открытое правило закрываем, правило с
 * непрочитанной шапкой доступно только на просмотр.
 */
export function ruleActionKey(isOpen: boolean, frontmatterOk: boolean): string {
  if (isOpen) return 'providerRules.close';
  if (frontmatterOk) return 'providerRules.edit';
  return 'providerRules.view';
}
