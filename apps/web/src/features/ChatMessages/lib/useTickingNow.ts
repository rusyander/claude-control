import { useEffect, useState } from 'react';

/**
 * «Сейчас», обновляемое раз в секунду, пока `isTicking`. Хабу разделения — для
 * времени идущего разбора и всего разделения: без тика цифра стояла бы с
 * момента последней перерисовки. Когда ничего не идёт, таймера нет вовсе.
 */
export function useTickingNow(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTicking) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isTicking]);

  return now;
}
