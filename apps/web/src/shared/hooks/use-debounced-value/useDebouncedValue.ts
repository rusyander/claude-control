import { useEffect, useState } from 'react';

/**
 * Возвращает значение с задержкой: обновляется только после того, как исходное
 * перестало меняться на `delay` миллисекунд. Нужен для поиска-по-мере-набора —
 * чтобы не слать запрос на каждый символ, а дождаться паузы в наборе.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
