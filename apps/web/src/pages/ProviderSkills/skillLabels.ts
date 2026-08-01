/**
 * Ошибка поля имени скилла: пустое поле молчит (человек ещё не начал), дальше —
 * нарушенная грамматика имени и уже занятое имя.
 */
export function skillNameError(
  input: { trimmed: string; nameValid: boolean; duplicate: boolean },
  t: (key: string) => string,
): string | undefined {
  if (!input.trimmed) return undefined;
  if (!input.nameValid) return t('providerSkills.nameInvalid');
  if (input.duplicate) return t('providerSkills.duplicate');
  return undefined;
}

/**
 * Ключ подписи кнопки строки скилла: открытый скилл закрываем, скилл с
 * непрочитанной шапкой доступен только на просмотр.
 */
export function skillActionKey(isOpen: boolean, frontmatterOk: boolean): string {
  if (isOpen) return 'common.close';
  if (frontmatterOk) return 'providerSkills.edit';
  return 'providerSkills.view';
}
