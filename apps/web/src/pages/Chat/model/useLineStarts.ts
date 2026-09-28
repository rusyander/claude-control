import { useCallback, useLayoutEffect, useState } from 'react';

/** Порог «новой строки»: дробные сдвиги раскладки строкой не считаются. */
const LINE_STEP = 2;

/** Ставит метку детям ряда, открывающим строку, и снимает её с остальных. */
function markLineStarts(row: HTMLElement): void {
  let lineTop: number | undefined;
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement) || child.offsetParent === null) continue;
    const top = child.offsetTop;
    const starts = lineTop === undefined || top > lineTop + LINE_STEP;
    if (starts) lineTop = top;
    if (starts && child.dataset.lineStart === undefined) child.dataset.lineStart = '';
    if (!starts && child.dataset.lineStart !== undefined) delete child.dataset.lineStart;
  }
}

/**
 * Помечает в переносимом ряду детей, которые начинают строку (`data-line-start`).
 *
 * Группы шапки чата разделены вертикальной чертой. В один ряд они влезают не
 * всегда — на узком окне ряд переносится, и черта у группы, открывающей новую
 * строку, висела бы у самого края ни к чему не относясь. CSS «первого в строке»
 * не знает, поэтому строку считаем по `offsetTop` и прячем черту по метке.
 * Скрытые (`display: none`, пустые группы) пропускаем — у них нет места в ряду.
 *
 * Возвращает ref-функцию, а не объект: ряд проекта появляется не с первым
 * рендером шапки (вкладка становится проектной позже), и эффект с пустыми
 * зависимостями его бы так и не увидел.
 */
export function useLineStarts<TElement extends HTMLElement>() {
  const [row, setRow] = useState<TElement | null>(null);
  const ref = useCallback((node: TElement | null) => setRow(node), []);

  useLayoutEffect(() => {
    if (!row) return;
    const mark = (): void => markLineStarts(row);
    mark();
    // Размер ряда меняет окно, состав — сами группы (кнопка доставки или
    // запуска появляется после ответа сервера); на то и другое пересчёт.
    const resize = new ResizeObserver(mark);
    resize.observe(row);
    const mutation = new MutationObserver(mark);
    mutation.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [row]);

  return ref;
}
