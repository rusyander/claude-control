import { useEffect, useState } from 'react';

/**
 * Текущее время, обновляемое раз в секунду, — пока `isTicking`. Таймер «идёт
 * 4м 12с» у вызова, фоновой команды и состояния группы в хабе: без него человек
 * не отличит долгую установку от зависшей. Тикать нечему — таймер стоит.
 */
export function useNow(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTicking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isTicking]);

  return now;
}
