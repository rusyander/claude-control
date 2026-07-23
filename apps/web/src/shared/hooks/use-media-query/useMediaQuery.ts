import { useEffect, useState } from 'react';

/**
 * Отслеживает медиазапрос и возвращает, выполняется ли он сейчас. Нужен там, где
 * раскладку задаёт JS (например, ширину боковой панели анимирует motion через
 * inline-стиль и CSS-медиазапрос до неё не дотягивается), а не чистый CSS.
 *
 * Значение считается синхронно при первом рендере — панель встаёт в нужную
 * ширину сразу, а не «прыгает» из широкой в узкую после монтирования.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);

    update();
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}
