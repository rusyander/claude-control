import styles from './status-dot.module.scss';
import type { StatusDotProps } from './status-dot.types';

/**
 * Цветная точка состояния. Зелёная — идёт работа (пульсирует), жёлтая — нужен
 * ответ человека, красная — ошибка, лимит или зависание. Без тона не рисуется:
 * «ничего не происходит» — это отсутствие точки, а не серый кружок.
 */
export function StatusDot({ tone, pulse, label }: StatusDotProps) {
  if (!tone) return null;

  return (
    <span
      className={[styles.dot, styles[tone], pulse && styles.pulse].filter(Boolean).join(' ')}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
