import type { SkeletonProps, SkeletonListProps } from './skeleton.types';
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

/** Несколько строк подряд — под списки и абзацы текста. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={`${styles.stack} ${className ?? ''}`} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          height={14}
          // Последняя строка короче — так заглушка похожа на настоящий абзац.
          width={index === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </span>
  );
}

/**
 * Заглушка списка карточек — самый частый случай в приложении: правила,
 * скиллы, хуки, серверы выглядят одинаково.
 */
export function SkeletonList({ rows = 4, withActions = true, className }: SkeletonListProps) {
  return (
    <div className={`${styles.list} ${className ?? ''}`} role="status" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.card}>
          <div className={styles.cardBody}>
            <Skeleton width={`${40 + ((index * 13) % 30)}%`} height={18} />
            <Skeleton width={`${65 + ((index * 7) % 25)}%`} height={13} />
          </div>

          {withActions && (
            <div className={styles.actions}>
              <Skeleton width={28} height={28} radius="md" />
              <Skeleton width={28} height={28} radius="md" />
              <Skeleton width={44} height={24} radius="full" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Заглушка плиток со сводкой — под сетку на обзоре. */
export function SkeletonTiles({ count = 6 }: { count?: number }) {
  return (
    <div className={styles.tiles} role="status" aria-label="Загрузка">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={styles.tile}>
          <Skeleton width="45%" height={14} />
          <Skeleton width="35%" height={30} />
          <Skeleton width="60%" height={12} />
        </div>
      ))}
    </div>
  );
}

/** Заглушка графика — прямоугольник в пропорциях будущей диаграммы. */
export function SkeletonChart({ height = 220 }: { height?: number }) {
  return (
    <div className={styles.chart} style={{ height }} role="status" aria-label="Загрузка">
      {Array.from({ length: 16 }, (_, index) => (
        <Skeleton
          key={index}
          width="100%"
          // Разная высота столбцов — иначе заглушка выглядит как пустая полоса.
          height={`${25 + ((index * 37) % 70)}%`}
          radius="sm"
        />
      ))}
    </div>
  );
}
