import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@shared/hooks/use-debounced-value';

/**
 * Текст поиска по кейсам: поле держит его само, а в фильтр доски он уходит
 * после паузы в наборе. Фильтр живёт на странице, и каждая буква иначе
 * перерисовывала бы её целиком — пульт, список и все закрытые окна.
 *
 * `applied` — то, что сейчас в фильтре. Снаружи он меняется сбросом и
 * сохранённым видом — тогда поле догоняет его; своё же отправленное значение
 * поле назад не принимает, иначе буква, набранная за время паузы, пропала бы.
 */
export function useDeferredQuery(
  applied: string,
  apply: (value: string) => void,
): [string, (value: string) => void] {
  const [query, setQuery] = useState(applied);
  const debounced = useDebouncedValue(query);
  const sent = useRef(applied);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (debounced === sent.current) return;
    sent.current = debounced;
    applyRef.current(debounced);
  }, [debounced]);

  useEffect(() => {
    if (applied === sent.current) return;
    sent.current = applied;
    setQuery(applied);
  }, [applied]);

  return [query, setQuery];
}
