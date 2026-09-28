import { useLayoutEffect, useRef } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { scrollIntent, type HistoryActionType } from './topicScroll';

/**
 * Позиции прокрутки по записям истории. Живут на уровне модуля, а не в
 * компоненте: «Назад» из другого раздела снова монтирует справку, и
 * запомненное в компоненте к этому моменту уже пропало бы.
 */
const positions = new Map<string, number>();

/** Каким переходом пришли к текущей записи. Подписка одна на историю роутера. */
let lastAction: HistoryActionType | undefined;
const tracked = new WeakSet<object>();

/**
 * Сколько ждать, пока документ «уляжется». Снимки справки грузятся лениво и
 * без заданной высоты: пока они не пришли, документ короче, и позиция на
 * девятой тысяче пикселей или якорь под снимками обрезаются. Прокрутка
 * повторяется при каждом росте содержимого, пока не дойдёт до цели, не
 * вмешается сам читатель или не выйдет это время.
 */
const SETTLE_MS = 2000;

/** Ближайший предок, который прокручивается сам (колонка раздела). */
function scrollParentOf(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll') return current;
  }
  return null;
}

/**
 * Прокрутка справки при смене документа: в начало, к якорю или туда, где
 * читатель был, если он вернулся кнопкой «Назад». Возвращает ref для
 * корневого блока страницы — по нему ищется прокручиваемая колонка.
 */
export function useTopicScroll() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const location = useRouterState({ select: (state) => state.location });
  const entryKey = location.state.__TSR_key ?? location.href;
  const { hash } = location;

  if (!tracked.has(router.history)) {
    tracked.add(router.history);
    router.history.subscribe(({ action }) => {
      lastAction = action.type;
    });
  }

  // Layout-эффект: сброс успевает до кадра, и читатель не видит мигания
  // старой высоты; снятие слушателя тоже синхронно — событие прокрутки,
  // вызванное обрезкой длины при смене документа, не запишется в прошлую запись.
  useLayoutEffect(() => {
    const scroller = scrollParentOf(rootRef.current);
    if (!scroller) return undefined;

    const intent = scrollIntent({ hash, action: lastAction, saved: positions.get(entryKey) });
    const apply = (): boolean => {
      if (intent.kind === 'anchor') {
        const target = document.getElementById(intent.id);
        // Якоря ещё нет (документ дорисовывается) или нет вовсе — пока в
        // начало, а не на высоте прошлого документа; появится — встанем к нему.
        if (!target) {
          scroller.scrollTop = 0;
          return false;
        }
        target.scrollIntoView({ block: 'start' });
        return true;
      }
      const top = intent.kind === 'restore' ? intent.top : 0;
      scroller.scrollTop = top;
      return Math.abs(scroller.scrollTop - top) <= 1;
    };

    let settled = apply();
    let userMoved = false;
    const deadline = Date.now() + SETTLE_MS;
    const observer = new ResizeObserver(() => {
      if (userMoved || Date.now() > deadline) return observer.disconnect();
      // Якорь держим до конца срока: снимки над ним сдвигают его и после того,
      // как он однажды попал на место.
      if (!settled || intent.kind === 'anchor') settled = apply();
    });
    // Сама колонка своего размера не меняет — растёт то, что в ней лежит.
    Array.from(scroller.children).forEach((child) => observer.observe(child));

    // Своё движение читателя сильнее: дальше документ не дёргаем.
    const stop = (): void => {
      userMoved = true;
    };
    const record = (): void => {
      positions.set(entryKey, scroller.scrollTop);
    };
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    inputs.forEach((type) => scroller.addEventListener(type, stop, { passive: true }));
    scroller.addEventListener('scroll', record, { passive: true });

    return () => {
      observer.disconnect();
      inputs.forEach((type) => scroller.removeEventListener(type, stop));
      scroller.removeEventListener('scroll', record);
    };
  }, [entryKey, hash]);

  return rootRef;
}
