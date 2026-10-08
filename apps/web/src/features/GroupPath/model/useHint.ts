import { useState, useEffect } from 'react';
import { ownsEscape } from '../lib/ownsEscape';

/**
 * Показ подсказки: наведение или фокус. Escape прячет её, не трогая фокус и
 * не закрывая окно вокруг: слушатель на window в фазе захвата срабатывает
 * раньше, чем окно на document. Но Escape, у которого есть свой хозяин —
 * поле ввода или другое окно поверх, — идёт дальше: подсказка, показанная
 * одним наведением, глотала Escape поля поиска и окна, открытого над путём.
 */
export function useHint(anchorRef: React.RefObject<HTMLElement | null>) {
  const [isShown, setIsShown] = useState(false);
  useEffect(() => {
    if (!isShown) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!ownsEscape(event.target, anchorRef.current)) event.stopPropagation();
      setIsShown(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isShown, anchorRef]);
  return { isShown, show: () => setIsShown(true), hide: () => setIsShown(false) };
}
