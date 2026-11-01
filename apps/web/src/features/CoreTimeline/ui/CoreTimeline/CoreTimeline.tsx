import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { timelineItems } from '../../model/items';
import { TimelineEntry } from '../TimelineEntry/TimelineEntry';
import type { CoreTimelineProps } from './CoreTimeline.types';
import styles from './CoreTimeline.module.scss';

/**
 * Лента задачи (07:18-20): строки журнала по времени, соединённые с видом ядра. Служебные строки
 * без показа не прячутся молча — их число стоит под лентой.
 */
export function CoreTimeline({ taskId, fold, view }: CoreTimelineProps) {
  const { t } = useTranslation();
  const items = useMemo(() => timelineItems(fold, view), [fold, view]);
  return (
    <Card padding="md" data-core-timeline data-last-seq={fold.lastSeq}>
      <Stack gap="var(--spacing-xs)">
        <Typography variant="heading-sm" as="h2">
          {t('coreTimeline.timeline.title')}
        </Typography>
        {items.length === 0 ? (
          <Typography variant="body-sm" color="muted">
            {t('coreTimeline.timeline.empty')}
          </Typography>
        ) : (
          <ol className={styles.list}>
            {items.map((entry) => (
              <TimelineEntry key={entry.row.seq} taskId={taskId} entry={entry} />
            ))}
          </ol>
        )}
        {fold.hidden > 0 && (
          <Typography variant="caption" color="subtle" data-core-hidden={fold.hidden}>
            {t('coreTimeline.timeline.hidden', { count: fold.hidden })}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
