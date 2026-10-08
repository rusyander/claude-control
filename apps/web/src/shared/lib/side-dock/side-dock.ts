/** Встать рядом с окном можно, только когда оно сдвигает страницу (широкий экран). */
export function isBesideDock(insetValue: string): boolean {
  const inset = Number.parseFloat(insetValue);
  return Number.isFinite(inset) && inset > 0;
}

/**
 * Сделать страницу недоступной, пока открыто модальное окно рядом с
 * пристёгнутым: вложенные окна держат её вместе, снимает последнее.
 */
let inertHolders = 0;

export function holdPageInert(page: HTMLElement | null): () => void {
  if (!page) return () => undefined;
  inertHolders += 1;
  page.inert = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inertHolders -= 1;
    if (inertHolders === 0) page.inert = false;
  };
}
