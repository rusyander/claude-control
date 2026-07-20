import { Skeleton } from './Skeleton';
import type { SkeletonTextProps } from './skeleton.types';
import styles from './skeleton.module.scss';

/** Несколько строк подряд — под списки и абзацы текста. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
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
