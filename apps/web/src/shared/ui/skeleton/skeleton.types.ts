export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: 'sm' | 'md' | 'full';
  className?: string;
}

export interface SkeletonListProps {
  rows?: number;
  /** Показывать ли справа заглушки кнопок и переключателя. */
  withActions?: boolean;
  className?: string;
}
