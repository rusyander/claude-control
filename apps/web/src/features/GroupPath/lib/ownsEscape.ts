/** Escape у элемента свой: поле ввода или другое окно, открытое поверх строки. */
export function ownsEscape(target: EventTarget | null, anchor: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  const windowOf = (node: Element | null): Element | null =>
    node?.closest('[role="dialog"]') ?? null;
  return windowOf(target) !== windowOf(anchor);
}
