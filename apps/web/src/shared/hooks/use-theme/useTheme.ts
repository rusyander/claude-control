import { useEffect, useState } from 'react';

/**
 * Текущая тема оформления. Провайдер темы проставляет её атрибутом на корне
 * документа, поэтому здесь мы не дублируем логику выбора, а просто следим за
 * этим атрибутом: подсветке кода нужно знать, светлая тема или тёмная.
 */
export function useTheme(): { theme: 'light' | 'dark' } {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  return { theme };
}

function readTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
