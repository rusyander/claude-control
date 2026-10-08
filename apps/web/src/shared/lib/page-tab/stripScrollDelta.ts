/**
 * На сколько прокрутить область вверх, чтобы новая вкладка открылась с начала.
 * Прилипшая полоса стоит у верха, а её место в потоке (`naturalTop`) уехало
 * выше: без поправки вкладка открывалась бы на середине чужого по длине списка,
 * подпись «что здесь» — за экраном. Полоса в своём месте — не трогаем (0).
 */
export function stripScrollDelta(naturalTop: number, scrollerTop: number, inset: number): number {
  const delta = naturalTop - (scrollerTop + inset);
  return delta < 0 ? delta : 0;
}
