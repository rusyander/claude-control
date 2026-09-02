import { useTranslation } from 'react-i18next';
import { Skeleton } from './Skeleton';
import type { SkeletonListProps } from './skeleton.types';
import styles from './skeleton.module.scss';

/**
 * Заглушка списка карточек — самый частый случай в приложении: правила,
 * скиллы, хуки, серверы выглядят одинаково.
 */
export function SkeletonList({ rows = 4, withActions = true, className }: SkeletonListProps) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.list} ${className ?? ''}`} role="status" aria-label={t('common.loading')}>
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
