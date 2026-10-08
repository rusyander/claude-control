/**
 * Ключ подписи кнопки строки правила: открытое правило закрываем, правило с
 * непрочитанной шапкой доступно только на просмотр.
 */
export function ruleActionKey(isOpen: boolean, frontmatterOk: boolean): string {
  if (isOpen) return 'providerRules.close';
  if (frontmatterOk) return 'providerRules.edit';
  return 'providerRules.view';
}
