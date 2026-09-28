/** Что пустой пульт ручного прохода может начать сам. */
export interface RunnerStartOffer {
  groupTitle: string;
  count: number;
}

/**
 * Предложение начать проход из пустого пульта.
 *
 * Берёт ровно то, что взяла бы кнопка «Пройти руками» в библиотеке: отмеченные
 * кейсы, а без отметок — видимые в выбранной группе. Нет группы или нечего
 * проходить — предложения нет: кнопка, запускающая пустой проход, была бы тем
 * же тупиком, только на шаг дальше.
 */
export function runnerStartOffer(input: {
  groups: readonly { id: string; title: string }[];
  activeId: string;
  checked: readonly string[];
  visible: number;
}): RunnerStartOffer | undefined {
  const group = input.groups.find((item) => item.id === input.activeId);
  if (!group) return undefined;
  const count = input.checked.length > 0 ? input.checked.length : input.visible;
  return count > 0 ? { groupTitle: group.title, count } : undefined;
}
