import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDraft, saveDraft } from './draft-storage';

/**
 * Черновик поля, привязанный к ключу контекста и сохраняемый в localStorage.
 *
 * Зачем ключ: у чата контекст меняется (другой разговор, другой проект, домашний
 * чат), и у каждого — свой невыпущенный текст. При смене ключа подгружаем
 * черновик нового контекста, а прежний уже лежит на диске. Пустое значение
 * стирает ключ. Пустой ключ (`undefined`) отключает запись — ведём себя как
 * обычный `useState`, ничего не пишем на диск.
 */
export function useDraft(key: string | undefined): [string, (value: string) => void] {
  const [value, setValue] = useState(() => (key ? loadDraft(key) : ''));
  const keyRef = useRef(key);

  // Ключ сменился (переключили чат/проект) — показываем черновик нового контекста.
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setValue(key ? loadDraft(key) : '');
  }, [key]);

  const set = useCallback((next: string) => {
    setValue(next);
    // Пишем под актуальный ключ из ref: замыкание колбэка не устаревает при смене.
    if (keyRef.current) saveDraft(keyRef.current, next);
  }, []);

  return [value, set];
}
