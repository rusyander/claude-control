/**
 * Модель прогона для узкой шапки: `claude-sonnet-5` → `sonnet-5`.
 *
 * Режется только приставка вендора, и только у Claude: на экране панели Claude
 * она не значит ничего, а место в строке решает. Имя чужого CLI остаётся как
 * есть — там вендор и есть ответ на вопрос «чем это работает».
 */
export function shortModel(model: string): string {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}
