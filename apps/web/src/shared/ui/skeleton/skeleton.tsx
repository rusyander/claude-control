import type { SkeletonProps } from './skeleton.types';
import styles from './skeleton.module.scss';

/**
 * Заглушка на время загрузки. Показывает форму того, что появится, — так
 * страница не прыгает, когда данные приходят, и видно, что именно грузится.
 *
 * Анимация отключается для тех, кто просил уменьшить движение: мерцающий
 * фон на весь экран для них неприятен.
 */
export function Skeleton({ width, height = 16, radius = 'sm', className }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${styles[radius]} ${className ?? ''}`}
      style={{ width, height }}
      aria-hidden
    />
  );
}
