/**
 * Ключ подписи кнопки строки скилла: открытый скилл закрываем, скилл с
 * непрочитанной шапкой доступен только на просмотр.
 */
export function skillActionKey(isOpen: boolean, frontmatterOk: boolean): string {
  if (isOpen) return 'common.close';
  if (frontmatterOk) return 'providerSkills.edit';
  return 'providerSkills.view';
}
