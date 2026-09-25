import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { formatDuration } from '@shared/lib/format-duration';
import { cn } from '@shared/lib/cn';
import { HUB_BUCKETS, summarizeHub } from '../lib/hubSummary';
import type { HubSummaryProps } from './HubSummary.types';
import styles from './ChildStages.module.scss';

/**
 * Строка-итог под шапкой хаба (L37): «готово 2 · идут 3 · ждёт вас 1 · …
 * · с начала 2ч 05м». Пустые корзины не пишутся: «упали: 0» — шум. «Ждёт вас»
 * выделена так же, как фишка вопроса в строке группы: после неё работа сама
 * не пойдёт.
 */
export function HubSummary({ groups, now }: HubSummaryProps) {
  const { t } = useTranslation();
  const { counts, elapsedMs } = summarizeHub(groups, now);
  const buckets = HUB_BUCKETS.filter((bucket) => counts[bucket] > 0);
  if (buckets.length === 0 && elapsedMs === undefined) return null;

  return (
    <div className={styles.summary} data-hub-summary>
      {buckets.map((bucket) => (
        <Typography
          key={bucket}
          variant="caption"
          color={bucket === 'ask' ? 'default' : 'subtle'}
          as="span"
          className={cn(styles.chip, bucket === 'ask' && styles.chipAsk)}
          data-hub-count={bucket}
          title={bucket === 'idle' ? t('chat.cascade.hub.summary.idleHint') : undefined}
        >
          {t(`chat.cascade.hub.summary.${bucket}`, { count: counts[bucket] })}
        </Typography>
      ))}
      {elapsedMs !== undefined && (
        <Typography variant="caption" color="subtle" as="span" data-hub-elapsed>
          {t('chat.cascade.hub.summary.elapsed', { time: formatDuration(elapsedMs, t) })}
        </Typography>
      )}
    </div>
  );
}
