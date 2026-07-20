import { Skeleton } from './Skeleton';
import type { SkeletonChartProps } from './skeleton.types';
import styles from './skeleton.module.scss';

/** Заглушка графика — прямоугольник в пропорциях будущей диаграммы. */
export function SkeletonChart({ height = 220 }: SkeletonChartProps) {
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
