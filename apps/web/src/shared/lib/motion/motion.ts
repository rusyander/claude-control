import type { Transition, Variants } from 'motion/react';

/**
 * Общий язык движения приложения.
 *
 * Анимации собраны в одном месте, чтобы панель, окна и списки двигались
 * одинаково: одна кривая, три длительности, повторяемые наборы состояний.
 * Разнобой заметен сразу — окно, которое появляется иначе, чем соседнее,
 * читается как чужое.
 *
 * Все длительности проходят через `withReducedMotion`: у приложения есть
 * переключатель «Меньше движения», и он должен выключать движение
 * по-настоящему, а не приглушать его.
 */

/** Основная кривая: быстрый старт, мягкое торможение. */
export const EASE = [0.22, 0.61, 0.36, 1] as const;

export const DURATION = {
  /** Отклик на действие: наведение, нажатие. */
  fast: 0.12,
  /** Появление окон и панелей. */
  normal: 0.22,
  /** Крупные перестроения — редко. */
  slow: 0.34,
} as const;

/** Пружина для того, что двигается в пространстве: панель, шторки. */
export const SPRING: Transition = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 };

/** Убирает движение целиком, когда пользователь об этом просил. */
export function withReducedMotion(transition: Transition, isReduced: boolean): Transition {
  return isReduced ? { duration: 0 } : transition;
}

export const FADE: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

/** Появление окна: чуть уменьшенное и ниже — как будто выходит навстречу. */
export const DIALOG: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0 },
};

/** Выезд снизу: подсказки, панели действий. */
export const RISE: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
};

/**
 * Список, который появляется по одному элементу. Задержка маленькая: на
 * длинном списке заметная лесенка раздражает больше, чем радует.
 */
export const STAGGER: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03 } },
};
