import { Skeleton } from './Skeleton';
import type { SkeletonTilesProps } from './skeleton.types';
import styles from './skeleton.module.scss';

/** Заглушка плиток со сводкой — под сетку на обзоре. */
export function SkeletonTiles({ count = 6 }: SkeletonTilesProps) {
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
