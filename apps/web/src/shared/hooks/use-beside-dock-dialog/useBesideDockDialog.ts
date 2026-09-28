import { useEffect, useState } from 'react';
import {
  holdPageInert,
  isInSideDock,
  sideDockTakesRoom,
  yieldEscapeToSideDock,
} from '@shared/lib/side-dock';

export interface BesideDockDialog {
  /** Окно встаёт слева от пристёгнутого окна агента, а не поверх (Radix modal={false}). */
  besideDock: boolean;
  onInteractOutside: (event: Event) => void;
  onEscapeKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Режим диалога страницы при пристёгнутом окне агента (`@shared/lib/side-dock`).
 *
 * Один на все диалоги страницы: палитра команд собрана на Radix напрямую, не на
 * `Modal`, и без общего хука снова закрывала окно агента затемнением (ревью Z5-13).
 * Режим решается в момент открытия и держится до конца анимации закрытия: смена
 * режима Radix на открытом окне пересоздала бы его содержимое вместе с набранным.
 * `block` — запрет закрытия у недискриминируемого окна.
 */
export function useBesideDockDialog(
  isOpen: boolean,
  block?: (event: Event) => void,
): BesideDockDialog {
  const [mode, setMode] = useState({ open: false, besideDock: false });
  if (mode.open !== isOpen) {
    setMode({ open: isOpen, besideDock: isOpen ? sideDockTakesRoom() : mode.besideDock });
  }
  const besideDock = mode.besideDock;

  // Radix без режима модальности не делает страницу недоступной и не держит её
  // прокрутку — делаем сами; окно агента живёт вне корня страницы и остаётся
  // доступным.
  useEffect(() => {
    if (!isOpen || !besideDock) return undefined;
    return holdPageInert(document.getElementById('root'));
  }, [isOpen, besideDock]);

  const onInteractOutside = (event: Event): void => {
    block?.(event);
    // Клик и фокус в окне агента или в другом диалоге — не «мимо окна».
    const target = event.target;
    if (
      besideDock &&
      (isInSideDock(target) || (target instanceof Element && target.closest('[role="dialog"]')))
    ) {
      event.preventDefault();
    }
  };
  const onEscapeKeyDown = (event: KeyboardEvent): void => {
    if (besideDock && isInSideDock(event.target)) {
      yieldEscapeToSideDock(event);
      return;
    }
    block?.(event);
  };

  return { besideDock, onInteractOutside, onEscapeKeyDown };
}
