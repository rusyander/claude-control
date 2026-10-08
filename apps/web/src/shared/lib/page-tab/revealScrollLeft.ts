/**
 * Куда сдвинуть полосу по горизонтали, чтобы активная вкладка была видна
 * целиком (узкий экран: полоса — одна прокручиваемая строка). Видна — не
 * двигаем: полоса, прыгающая от каждого нажатия, сбивает.
 */
export function revealScrollLeft(
  tabLeft: number,
  tabWidth: number,
  scrollLeft: number,
  viewWidth: number,
  margin = 8,
): number {
  if (tabLeft < scrollLeft) return Math.max(0, tabLeft - margin);
  if (tabLeft + tabWidth > scrollLeft + viewWidth) return tabLeft + tabWidth - viewWidth + margin;
  return scrollLeft;
}
