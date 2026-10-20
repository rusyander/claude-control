import { useEffect, useRef, useState } from 'react';

/** Столько без клавиш, кликов и движения мыши — и Дека задрёмывает. */
export const SLEEP_AFTER_MS = 5 * 60_000;

/** Как часто сверяться с часами: сон — не секундное дело. */
const CHECK_EVERY_MS = 15_000;

const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;

/**
 * Когда человек последний раз что-то делал и не пора ли спать. `canSleep` —
 * снаружи: пока агенты работают или кто-то ждёт, Дека не спит. Проснулся —
 * `onWake`. Слушатели пассивные и только пишут время в ref: движение мыши не
 * должно перерисовывать боковую панель.
 */
export function useActivity(canSleep: boolean, onWake: () => void) {
  const lastInputAt = useRef(Date.now());
  const [isAsleep, setAsleep] = useState(false);
  const asleepRef = useRef(false);
  const wakeRef = useRef(onWake);
  wakeRef.current = onWake;

  useEffect(() => {
    const onInput = (): void => {
      lastInputAt.current = Date.now();
      if (!asleepRef.current) return;
      asleepRef.current = false;
      setAsleep(false);
      wakeRef.current();
    };
    INPUT_EVENTS.forEach((name) => window.addEventListener(name, onInput, { passive: true }));
    return () => INPUT_EVENTS.forEach((name) => window.removeEventListener(name, onInput));
  }, []);

  useEffect(() => {
    const check = (): void => {
      const next = canSleep && Date.now() - lastInputAt.current >= SLEEP_AFTER_MS;
      if (next === asleepRef.current) return;
      asleepRef.current = next;
      setAsleep(next);
    };
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [canSleep]);

  return { isAsleep, lastInputAt };
}
