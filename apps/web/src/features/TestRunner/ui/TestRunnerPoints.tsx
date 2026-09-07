import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { STATUS_TONE } from '@entities/ProjectTest';
import type { TestRunnerPointsProps } from './TestRunnerPoints.types';
import styles from './TestRunner.module.scss';

/**
 * Список проходов слева.
 *
 * Показывает не кейсы, а тест-поинты: кейс с параметрами и двумя окружениями —
 * это шесть отдельных проходов, и человеку надо видеть, сколько именно работы
 * осталось, а не сколько кейсов «в плане».
 */
export function TestRunnerPoints({ points, results, index, onSelect }: TestRunnerPointsProps) {
  const { t } = useTranslation();
  const statusOf = (pointId: string) =>
    results.find((item) => item.pointId === pointId)?.status ?? 'unknown';

  return (
    <Stack gap="var(--spacing-3xs)" as="nav" aria-label={t('tests.runner.points')}>
      {points.map((point, position) => {
        const status = statusOf(point.id);
        return (
          <button
            key={point.id}
            type="button"
            className={[styles.point, position === index && styles.pointActive]
              .filter(Boolean)
              .join(' ')}
            aria-current={position === index ? 'true' : undefined}
            onClick={() => onSelect(position)}
          >
            <span className={styles.pointNumber}>{position + 1}</span>
            <span className={styles.pointText}>
              <Typography variant="body-sm" as="span" truncate>
                {point.title}
              </Typography>
              {point.params && Object.keys(point.params).length > 0 && (
                <Typography variant="caption" color="subtle" as="span">
                  {Object.entries(point.params)
                    .map(([name, value]) => `${name}=${value}`)
                    .join(' · ')}
                </Typography>
              )}
            </span>
            <Badge tone={STATUS_TONE[status]}>{t(`projectTests.status.${status}`)}</Badge>
          </button>
        );
      })}
    </Stack>
  );
}
