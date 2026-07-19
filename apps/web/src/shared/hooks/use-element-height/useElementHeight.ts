import { useEffect, useRef, useState } from 'react';

/**
 * Высота элемента с отслеживанием изменений. Нужна виртуальным спискам:
 * им требуется высота числом, а раскладка задаётся сеткой и меняется вместе
 * с размером окна.
 */
export function useElementHeight<TElement extends HTMLElement>(fallback: number) {
  const ref = useRef<TElement>(null);
  const [height, setHeight] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.height ?? 0;
      if (next > 0) setHeight(next);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}
