/**
 * Куда встанет шаг, который кладут «сразу после строки `afterIndex`» (индекс ДО переноса):
 * индекс в списке без самого шага. Место «сразу после себя» и «сразу перед собой» — одно и то
 * же, шаг не двигается — `null`. Одно правило и у перетаскивания, и у переноса в «Порядке
 * работы» групп, и в редакторе сценария ядра: разойдись они, ручка показала бы одно место, а
 * шаг встал бы в другое.
 */
export function slotTarget(from: number, afterIndex: number): number | null {
  if (afterIndex === from || afterIndex === from - 1) return null;
  return afterIndex > from ? afterIndex - 1 : afterIndex;
}

/**
 * Перенос элемента `from` на место после `afterIndex` (−1 — в самое начало) в плоском списке.
 * Ничего не меняется или индекс вне списка — тот же массив, а не копия: изменения нет.
 */
export function moveAfter<T>(items: readonly T[], from: number, afterIndex: number): readonly T[] {
  const item = items[from];
  const at = slotTarget(from, afterIndex);
  if (item === undefined || at === null || afterIndex < -1 || afterIndex >= items.length) {
    return items;
  }
  const rest = items.filter((_, index) => index !== from);
  return [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)];
}
