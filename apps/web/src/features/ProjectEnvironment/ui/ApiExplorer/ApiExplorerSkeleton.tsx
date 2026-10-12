import { useTranslation } from 'react-i18next';
import { Skeleton, SkeletonText } from '@shared/ui/skeleton';
import styles from './ApiExplorer.module.scss';

/**
 * Заглушки вкладки «API» в форме того, что появится: карточки контракта и
 * цели, список эндпоинтов слева, запрос справа. Пока ищется контракт и
 * опрашиваются сервисы, раскладка уже на месте и не прыгает.
 */
export function ApiExplorerSkeleton() {
  const { t } = useTranslation();
  return (
    <div className={styles.block} role="status" aria-label={t('environment.api.specLoading')}>
      <div className={styles.card}>
        <Skeleton width={120} height={12} />
        <Skeleton width="100%" height={36} radius="md" />
        <Skeleton width={280} height={12} />
      </div>
      <div className={styles.card}>
        <Skeleton width={160} height={14} />
        <Skeleton width="100%" height={34} radius="md" />
        <div className={styles.skeletonChips}>
          <Skeleton width={220} height={28} radius="md" />
          <Skeleton width={180} height={28} radius="md" />
          <Skeleton width={200} height={28} radius="md" />
        </div>
      </div>
      <div className={styles.workspace}>
        <div className={styles.listCard}>
          <Skeleton width={100} height={14} />
          <Skeleton width="100%" height={34} radius="md" />
          <ApiEndpointsSkeleton />
        </div>
        <div className={styles.card}>
          <Skeleton width={90} height={14} />
          <Skeleton width="60%" height={24} radius="md" />
          <SkeletonText lines={3} />
          <Skeleton width="100%" height={120} radius="md" />
        </div>
      </div>
    </div>
  );
}

/** Строки списка эндпоинтов: метка метода и две строки текста. */
export function ApiEndpointsSkeleton() {
  return (
    <div className={styles.skeletonRows} aria-hidden>
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className={styles.skeletonEndpoint}>
          <Skeleton width={46} height={20} radius="md" />
          <div className={styles.skeletonEndpointText}>
            <Skeleton width={`${55 + ((index * 17) % 35)}%`} height={12} />
            <Skeleton width={`${35 + ((index * 23) % 30)}%`} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ответ в пути: строка статуса и тело — на месте будущей карточки ответа. */
export function ApiResponseSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.card} role="status" aria-label={label}>
      <div className={styles.skeletonChips}>
        <Skeleton width={64} height={22} radius="md" />
        <Skeleton width={90} height={14} />
        <Skeleton width={60} height={14} />
      </div>
      <Skeleton width="100%" height={160} radius="md" />
      <span className={styles.sub}>{label}</span>
    </div>
  );
}
