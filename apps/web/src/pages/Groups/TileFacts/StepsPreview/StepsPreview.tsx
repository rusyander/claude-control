import type { StepsPreviewProps } from '../TileFacts.types';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import styles from './StepsPreview.module.scss';

export function StepsPreview({ steps, failed, more, emptyText }: StepsPreviewProps) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsFailed')}
      </Typography>
    );
  }
  if (!steps) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsReading')}
      </Typography>
    );
  }
  if (steps.length === 0) {
    return (
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {emptyText}
      </Typography>
    );
  }
  return (
    <div className={styles.steps}>
      <Typography variant="caption" color="subtle" as="p" className={styles.line}>
        {t('groupsPage.tile.stepsLabel')}
      </Typography>
      <ol className={styles.list}>
        {steps.map((title, index) => (
          <li key={`${index}-${title}`} className={styles.step}>
            {title}
          </li>
        ))}
      </ol>
      {more > 0 && (
        <Typography variant="caption" color="subtle" as="p" className={styles.line}>
          {t('groupsPage.tile.more', { count: more })}
        </Typography>
      )}
    </div>
  );
}
