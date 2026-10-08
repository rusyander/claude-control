import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { edgeScrollDelta } from '../lib/edgeScrollDelta';

/** Взятый шаг: откуда (индекс в `entries`) и куда его положат (`afterIndex`). */
export interface DragState {
  stepId: string;
  title: string;
  from: number;
  target: number;
  mode: 'pointer' | 'keyboard';
}

/** Атрибут ручки: по нему фокус находит ручку перенесённого шага после перерисовки. */
export const DRAG_HANDLE_ATTR = 'data-drag-handle';

export interface DragHandleProps {
  [DRAG_HANDLE_ATTR]: string;
  'aria-disabled': true | undefined;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
}

interface Options {
  /** Места «+» по порядку экрана (`dropSlots`). */
  slots: number[];
  /** Название строки `entries[index]` — для объявления «после …». */
  titleAt: (index: number) => string;
  onDrop: (stepId: string, afterIndex: number) => void;
  /** Путь сохраняется: ручки остаются на месте (и в фокусе), но жесты не принимаются. */
  isBusy?: boolean;
}
/** Сколько ждать перерисовки пути, прежде чем перестать возвращать фокус (мс). */
const FOCUS_WINDOW = 3000;

/** Ближайший предок, который прокручивается по вертикали (окно группы — не страница). */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Перенос своего шага: мышью или пальцем за ручку (указатель захвачен ручкой,
 * место — ближайший по высоте «+», у края окна список едет сам) и с клавиатуры
 * (Пробел берёт, стрелки ведут по местам, Пробел кладёт, Escape отменяет;
 * после переноса фокус остаётся на ручке перенесённого шага). Каждое движение
 * объявляется в живой области: без неё перенос с клавиатуры шёл бы вслепую.
 *
 * Место «сразу после себя» и «сразу перед собой» — одно и то же (шаг не
 * двигается), поэтому в списке мест для шага остаётся только второе.
 */
export function useStepDrag({ slots, titleAt, onDrop, isBusy = false }: Options) {
  const { t } = useTranslation();
  const [drag, setDragState] = useState<DragState | undefined>(undefined);
  // События указателя идут чаще перерисовки: обработчик читает взятый шаг из
  // ссылки, иначе первое быстрое движение после нажатия видит «ничего не взято».
  const dragRef = useRef<DragState | undefined>(undefined);
  const setDrag = (next: DragState | undefined): void => {
    dragRef.current = next;
    setDragState(next);
  };
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);
  /**
   * Шаг, чья ручка должна остаться в фокусе после переноса с клавиатуры. Путь
   * перерисовывается после ответа сервера, строки переставляются, и браузер
   * снимает фокус с переставленной кнопки — второй перенос шёл бы в никуда.
   */
  const focusRef = useRef<{ stepId: string; until: number } | undefined>(undefined);
  /** Прокрутка у края, пока шаг держат мышью или пальцем. */
  const scrollRef = useRef<{ frame: number; y: number; from: number } | undefined>(undefined);

  const stopScroll = (): void => {
    if (scrollRef.current) cancelAnimationFrame(scrollRef.current.frame);
    scrollRef.current = undefined;
  };

  // Возврат фокуса: после каждой перерисовки, пока путь сохраняется и приходит
  // заново. Фокус, который человек сам увёл в другое место, не трогаем —
  // возвращаем только потерянный (на body или на окне вокруг списка).
  useEffect(() => {
    const pending = focusRef.current;
    if (!pending || isBusy) return;
    if (Date.now() > pending.until) {
      focusRef.current = undefined;
      return;
    }
    const node = listRef.current?.querySelector<HTMLButtonElement>(
      `[${DRAG_HANDLE_ATTR}="${CSS.escape(pending.stepId)}"]`,
    );
    const active = document.activeElement;
    const isLost =
      !active ||
      active === document.body ||
      Boolean(listRef.current && active.contains(listRef.current));
    if (node && active !== node && isLost) node.focus();
  });

  useEffect(
    () => () => {
      if (scrollRef.current) cancelAnimationFrame(scrollRef.current.frame);
    },
    [],
  );

  // Escape переноса с клавиатуры — на window в фазе захвата. Окно вокруг (Radix)
  // слушает Escape на документе тоже в захвате, раньше обработчика ручки, и
  // закрывалось вместо отмены; отсюда событие дальше не идёт вовсе.
  useEffect(() => {
    if (drag?.mode !== 'keyboard') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const placesFor = (from: number): number[] => slots.filter((slot) => slot !== from);
  const describe = (state: DragState, target: number): string => {
    const places = placesFor(state.from);
    const position = Math.max(0, places.indexOf(target)) + 1;
    return target < 0
      ? t('groupBuilder.drag.atStart', { position, total: places.length })
      : t('groupBuilder.drag.at', { position, total: places.length, after: titleAt(target) });
  };

  const commit = (state: DragState): void => {
    setDrag(undefined);
    stopScroll();
    if (state.target === state.from || state.target === state.from - 1) {
      setAnnouncement(t('groupBuilder.drag.unchanged', { title: state.title }));
      return;
    }
    const position = placesFor(state.from).indexOf(state.target) + 1;
    if (state.mode === 'keyboard') {
      focusRef.current = { stepId: state.stepId, until: Date.now() + FOCUS_WINDOW };
    }
    onDrop(state.stepId, state.target);
    setAnnouncement(t('groupBuilder.drag.dropped', { title: state.title, position }));
  };

  const cancel = (): void => {
    stopScroll();
    if (!drag) return;
    setDrag(undefined);
    setAnnouncement(t('groupBuilder.drag.cancelled', { title: drag.title }));
  };

  /** Ближайшее по высоте место — указатель редко стоит ровно на тонкой линии «+». */
  const nearestSlot = (clientY: number, from: number): number | undefined => {
    const nodes = listRef.current?.querySelectorAll<HTMLElement>('[data-drop-after]') ?? [];
    let best: { slot: number; distance: number } | undefined;
    for (const node of nodes) {
      const slot = Number(node.dataset.dropAfter);
      if (slot === from) continue;
      const box = node.getBoundingClientRect();
      const distance = Math.abs(box.top + box.height / 2 - clientY);
      if (!best || distance < best.distance) best = { slot, distance };
    }
    return best?.slot;
  };

  const retarget = (clientY: number, from: number): void => {
    const current = dragRef.current;
    if (current?.mode !== 'pointer') return;
    const target = nearestSlot(clientY, from);
    if (target !== undefined && target !== current.target) setDrag({ ...current, target });
  };

  /**
   * Длинный путь (до 80 шагов) не влезает в окно, а палец за край экрана не
   * вынести: пока взятый шаг держат у края, список едет сам, и место под
   * пальцем пересчитывается на каждом кадре — даже если палец стоит.
   */
  const tick = (): void => {
    const state = scrollRef.current;
    const scroller = scrollParent(listRef.current);
    if (!state || !scroller || dragRef.current?.mode !== 'pointer') return stopScroll();
    const isPage = scroller === document.scrollingElement;
    const box = isPage ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
    const delta = edgeScrollDelta(state.y, box.top, box.bottom);
    if (delta === 0) return stopScroll();
    const before = scroller.scrollTop;
    scroller.scrollTop = before + delta;
    if (scroller.scrollTop === before) return stopScroll();
    retarget(state.y, state.from);
    state.frame = requestAnimationFrame(tick);
  };

  const followEdge = (clientY: number, from: number): void => {
    if (scrollRef.current) {
      scrollRef.current.y = clientY;
      return;
    }
    scrollRef.current = { frame: 0, y: clientY, from };
    scrollRef.current.frame = requestAnimationFrame(tick);
  };

  const handleProps = (stepId: string, from: number, title: string): DragHandleProps => ({
    [DRAG_HANDLE_ATTR]: stepId,
    'aria-disabled': isBusy || undefined,
    onPointerDown: (event) => {
      if (event.button !== 0 || isBusy) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ stepId, title, from, target: from - 1, mode: 'pointer' });
    },
    onPointerMove: (event) => {
      const current = dragRef.current;
      if (current?.mode !== 'pointer' || current.stepId !== stepId) return;
      retarget(event.clientY, from);
      followEdge(event.clientY, from);
    },
    onPointerUp: () => {
      const current = dragRef.current;
      if (current?.mode === 'pointer' && current.stepId === stepId) commit(current);
    },
    onPointerCancel: cancel,
    onKeyDown: (event) => {
      const isPick = event.key === ' ' || event.key === 'Enter';
      // Человек снова жмёт на ручке — фокус на месте, возвращать его больше не нужно.
      focusRef.current = undefined;
      if (!drag || drag.stepId !== stepId) {
        if (!isPick) return;
        event.preventDefault();
        // Путь ещё сохраняется: взять шаг сейчас значит переносить по старому списку.
        if (isBusy) return;
        const state: DragState = { stepId, title, from, target: from - 1, mode: 'keyboard' };
        setDrag(state);
        const places = placesFor(from);
        setAnnouncement(
          t('groupBuilder.drag.picked', {
            title,
            position: places.indexOf(from - 1) + 1,
            total: places.length,
          }),
        );
        return;
      }
      if (isPick) {
        event.preventDefault();
        commit(drag);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const places = placesFor(from);
        const at = places.indexOf(drag.target);
        const next =
          places[Math.min(places.length - 1, Math.max(0, at + (event.key === 'ArrowUp' ? -1 : 1)))];
        if (next === undefined) return;
        setDrag({ ...drag, target: next });
        setAnnouncement(describe(drag, next));
      }
    },
    onBlur: () => {
      if (drag?.mode === 'keyboard' && drag.stepId === stepId) cancel();
    },
  });

  return { drag, announcement, listRef, handleProps };
}
