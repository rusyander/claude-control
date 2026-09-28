/**
 * Куда ведёт клавиша в группе с одной остановкой Tab (радиогруппа, полоса
 * вкладок): стрелки вправо/вниз — следующий, влево/вверх — предыдущий, с края
 * по кругу; Home/End — крайние. `undefined` — клавиша не из этой навигации (её
 * не перехватываем) или идти некуда.
 *
 * Текущего нет в списке (ничего не выбрано) — стрелка ведёт с края: вперёд к
 * первому, назад к последнему, а не «мимо» по индексу −1.
 */
export function rovingTarget<T>(
  items: readonly T[],
  current: T | undefined,
  key: string,
): T | undefined {
  if (items.length === 0) return undefined;
  const at = current === undefined ? -1 : items.indexOf(current);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return items[(at + 1) % items.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return items[at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length];
    case 'Home':
      return items[0];
    case 'End':
      return items[items.length - 1];
    default:
      return undefined;
  }
}
