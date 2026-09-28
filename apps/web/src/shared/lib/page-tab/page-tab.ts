/**
 * Вкладки страницы раздела: какая открыта и как её запомнить.
 *
 * Правила одни на все разделы с вкладками, поэтому живут здесь, а не в каждой
 * странице: адрес (`?tab=…`) главнее памяти — ссылкой делятся ровно на то, что
 * видно; без адреса открывается запомненная вкладка, иначе первая. Незнакомое
 * значение (ссылка устарела после переименования вкладки) не даёт пустого
 * экрана и не считается ошибкой.
 */
export function pickPageTab<T extends string>(
  ids: readonly T[],
  fromUrl: unknown,
  remembered: unknown,
): T {
  const known = (value: unknown): value is T =>
    typeof value === 'string' && (ids as readonly string[]).includes(value);
  if (known(fromUrl)) return fromUrl;
  if (known(remembered)) return remembered;
  const first = ids[0];
  if (first === undefined) throw new Error('pickPageTab: у страницы нет ни одной вкладки');
  return first;
}

/**
 * Параметр `tab` сырого адреса нужно заменить открытой вкладкой: он есть и
 * не равен ей. Сырой — потому что `?tab=1` роутер разбирает числом, и
 * разобранный адрес страницы его уже не несёт, а в строке браузера он
 * остаётся (F-337).
 */
export function unknownTabParam(raw: unknown, active: string): boolean {
  return raw !== undefined && raw !== active;
}

/** Ключ памяти вкладки: у каждого зрителя своя, в его браузере, отдельно по разделам. */
export function pageTabStorageKey(page: string): string {
  return `agentdeck.${page}.tab`;
}

/**
 * Хранилище браузера бывает недоступно (приватное окно, запрет сайта): тогда
 * вкладка просто не запоминается, страница работает как без памяти.
 */
export function readRememberedPageTab(page: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(pageTabStorageKey(page)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberPageTab(page: string, tab: string): void {
  try {
    globalThis.localStorage?.setItem(pageTabStorageKey(page), tab);
  } catch {
    // Память вкладки — удобство, а не данные: без неё ничего не ломается.
  }
}

/** Кнопка вкладки и её панель ссылаются друг на друга — id считаем в одном месте. */
export function pageTabDomId(page: string, tab: string): string {
  return `${page}-tab-${tab}`;
}

export function pageTabPanelDomId(page: string, tab: string): string {
  return `${page}-panel-${tab}`;
}

/**
 * Куда уходит фокус со стрелки: соседняя вкладка, с края — на другой край
 * (список короткий, упираться в него нечем). Home/End — первая и последняя.
 * Незнакомая клавиша — `undefined`: событие не наше, его не гасим.
 */
export function nextPageTab<T extends string>(
  ids: readonly T[],
  active: T,
  key: string,
): T | undefined {
  if (ids.length === 0) return undefined;
  const index = Math.max(0, ids.indexOf(active));
  const at = (offset: number): T | undefined => ids[(index + offset + ids.length) % ids.length];
  if (key === 'ArrowRight' || key === 'ArrowDown') return at(1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return at(-1);
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return undefined;
}

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
