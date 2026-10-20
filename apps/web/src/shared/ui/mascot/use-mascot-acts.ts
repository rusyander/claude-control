import { useEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion';
import { ACT_MS, firstDelay, hasActs, pickAct, type MascotAct } from './mascot-acts';
import type { MascotMood } from './mascot.types';

/**
 * Ведёт разовые действия Деки: пишет `data-act` прямо в элемент, мимо React —
 * смена действия не перерисовывает компонент, только запускает CSS-кадры.
 * Между действиями атрибута нет, и браузер стоит.
 *
 * Смена настроения — короткое «сжался-выпрямился» (кроме первого показа).
 * При «Меньше движения» и в скрытой вкладке не делает ничего.
 */
export function useMascotActs(root: RefObject<HTMLElement | null>, mood: MascotMood): void {
  const isReduced = useReducedMotion();
  const shownMood = useRef<MascotMood | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || isReduced) return undefined;
    let timer = 0;

    const set = (act: MascotAct | null): void => {
      if (act) element.dataset.act = act;
      else delete element.dataset.act;
    };

    const play = (act: MascotAct, then: () => void): void => {
      set(act);
      timer = window.setTimeout(() => {
        set(null);
        then();
      }, ACT_MS[act]);
    };

    const next = (): void => {
      const picked = pickAct(mood);
      if (!picked) return;
      play(picked.act, () => {
        timer = window.setTimeout(next, picked.gap);
      });
    };

    const start = (): void => {
      window.clearTimeout(timer);
      set(null);
      if (document.hidden) return;
      timer = window.setTimeout(next, firstDelay(mood));
    };

    // Вспышкам (радость, головокружение) «сжался» не нужен: их движение и есть вход.
    const isSwitch = shownMood.current !== null && shownMood.current !== mood && hasActs(mood);
    shownMood.current = mood;
    if (isSwitch && !document.hidden) play('switch', start);
    else start();

    document.addEventListener('visibilitychange', start);
    return () => {
      document.removeEventListener('visibilitychange', start);
      window.clearTimeout(timer);
      set(null);
    };
  }, [root, mood, isReduced]);
}
