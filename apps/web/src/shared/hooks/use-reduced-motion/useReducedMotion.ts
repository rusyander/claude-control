import { useEffect, useState } from 'react';

/**
 * Просит ли пользователь меньше движения. Учитываем и системную настройку,
 * и переключатель в настройках приложения: анимация волны заметная, и её
 * нужно уметь выключить.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');

    const update = (): void => {
      const fromApp = document.documentElement.dataset.reduceMotion === 'true';
      setReduced(media.matches || fromApp);
    };

    update();
    media.addEventListener('change', update);

    // Настройка приложения меняет data-атрибут на <html> — следим и за ним.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-reduce-motion'],
    });

    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);

  return reduced;
}
