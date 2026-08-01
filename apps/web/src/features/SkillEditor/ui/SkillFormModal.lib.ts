/**
 * Ключ подписи главной кнопки конструктора. Кнопка объясняет, что произойдёт:
 * у уже существующего скилла это сохранение (пока скилла нет — сохранение одной
 * шапки), а до создания — создание, у конструктора сразу с переходом к сборке.
 */
export function primaryLabelKey(input: {
  hasActiveId: boolean;
  hasSkill: boolean;
  isBuilder: boolean;
}): string {
  if (input.hasActiveId) return input.hasSkill ? 'common.save' : 'skills.saveFrontmatter';
  return input.isBuilder ? 'skills.createAndBuild' : 'common.save';
}
