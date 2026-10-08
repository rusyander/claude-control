import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * React-ключ карточки хаба. У группы без чата `chatId` — пустая строка, не
 * `undefined`: `chatId ?? title` давал двум ждущим группам один ключ `""`
 * (наблюдатель WR-9, 54 повтора), и React волен был потерять или задвоить
 * карточку. Без чата ключом служит номер группы, без номера — её имя.
 */
export function hubCardKey(group: ChildStageGroup): string {
  if (group.chatId) return group.chatId;
  return typeof group.groupIndex === 'number' ? `#${group.groupIndex}` : group.title;
}
