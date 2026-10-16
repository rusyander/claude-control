import { useEffect, useState } from 'react';

/** Раз в полминуты: «5 мин» не должны стоять на экране, пока прошло полчаса. */
const CLOCK_MS = 30_000;

/** Текущее время для подписей свежести («2 ч»), обновляется само. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
