import { useEffect, useState } from 'react';

/**
 * Куда рисовать стопку тостов: в верхнее открытое модальное окно, а без него — в `body`.
 *
 * Модальное окно Radix прячет всё вне себя: соседей `body` помечает `aria-hidden`, Tab держит
 * ловушкой фокуса внутри окна, а нажатие снаружи считает попыткой закрыть окно. Тост в `body`
 * поверх окна был виден, но недоступен с клавиатуры и для чтения с экрана — «Закрыть» и
 * «Подробнее» не достать (этап 12). Внутри окна тост — часть окна для всех трёх механизмов.
 */
const OPEN_DIALOG = '[role="dialog"][data-state="open"]';
// У всплывашки Radix (Popover, выбор дат) те же role="dialog" и data-state="open", но она не
// модальна, а её обёртка сдвинута transform: тост в ней встал бы у всплывашки и пропал вместе с ней.
const POPPER = '[data-radix-popper-content-wrapper]';

function topDialog(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>(OPEN_DIALOG)].filter(
    (el) => !el.closest(POPPER),
  );
  return open.length > 0 ? open[open.length - 1]! : null;
}

export function useToastHost(): HTMLElement | null {
  const [dialog, setDialog] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : topDialog(),
  );
  useEffect(() => {
    // Окна открываются порталами в `body` и закрываются сменой `data-state`: следим за обоими.
    const observer = new MutationObserver(() => {
      const next = topDialog();
      setDialog((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    return () => observer.disconnect();
  }, []);
  return dialog;
}
