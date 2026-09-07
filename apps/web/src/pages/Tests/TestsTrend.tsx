import { useTranslation } from 'react-i18next';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { Typography } from '@shared/ui/typography';
import { trendBars } from './model/reportMetrics';
import styles from './TestsPage.module.scss';

/**
 * Тренд по прогонам: столбик на прогон, зелёное снизу, красное сверху.
 *
 * Столбики, а не линия: прогоны идут неравномерно (три за час, потом день
 * тишины), и линия между ними рисовала бы плавное изменение, которого не было.
 * Столбик честно говорит «вот прогон, вот его состав».
 *
 * Рисуется голым SVG в координатах 0…100 по обеим осям и растягивается
 * `preserveAspectRatio="none"`: так график занимает всю ширину карточки без
 * измерения контейнера и перерисовки на каждый ресайз.
 */
export function TestsTrend({ runs }: { runs: ProjectTestRunRecord[] }) {
  const { t } = useTranslation();
  const items = trendBars(runs);

  if (items.length === 0) {
    return (
      <Typography variant="caption" color="subtle">
        {t('tests.report.trendEmpty')}
      </Typography>
    );
  }

  return (
    <svg
      className={styles.trend}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={t('tests.report.trendLabel', { count: items.length })}
    >
      {items.map((bar) => (
        <g key={bar.id}>
          <rect
            x={bar.x}
            y={100 - bar.passed}
            width={bar.width}
            height={bar.passed}
            className={styles.trendPassed}
          />
          <rect
            x={bar.x}
            y={100 - bar.passed - bar.failed}
            width={bar.width}
            height={bar.failed}
            className={styles.trendFailed}
          />
        </g>
      ))}
    </svg>
  );
}
