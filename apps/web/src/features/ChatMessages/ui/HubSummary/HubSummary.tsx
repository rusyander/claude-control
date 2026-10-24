import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { formatDuration } from '@shared/lib/format-duration';
import { cn } from '@shared/lib/cn';
import { HUB_BUCKETS } from '../../lib/hubSummary';
import type { HubSummaryProps } from './HubSummary.types';
import styles from './HubSummary.module.scss';
import { summarizeHub } from '../../lib/summarizeHub';
import { keepWarmTotal } from '../../lib/keepWarmTotal';

/**
 * Строка-итог под шапкой хаба (L37): «готово 2 · идут 3 · ждёт вас 1 · …
 * · с начала 2ч 05м». Пустые корзины не пишутся: «упали: 0» — шум. «Ждёт вас»
 * выделена так же, как фишка вопроса в строке группы: после неё работа сама
 * не пойдёт.
 */
export function HubSummary({ groups, now }: HubSummaryProps) {
  const { t, i18n } = useTranslation();
  const { counts, elapsedMs } = summarizeHub(groups, now);
  // Итог подогрева кэша по всем группам: сколько сберегла экономия — числом.
  const warm = keepWarmTotal(groups);
  const buckets = HUB_BUCKETS.filter((bucket) => counts[bucket] > 0);
  // Активные сигналы сторожа всех групп (фаза 2, W.4): тревога красит фишку,
  // «внимание» выделяет, одни сведения — спокойная фишка.
  const signals = groups.flatMap((group) =>
    (group.watchSignals ?? []).filter((signal) => !signal.clearedAt),
  );
  const severities = new Set(signals.map((signal) => signal.severity));
  let tone: 'alarm' | 'warn' | 'info' = 'info';
  if (severities.has('alert')) tone = 'alarm';
  else if (severities.has('warn')) tone = 'warn';
  if (buckets.length === 0 && elapsedMs === undefined && signals.length === 0 && !warm) {
    return null;
  }

  return (
    <div className={styles.summary} data-hub-summary>
      {buckets.map((bucket) => (
        <Typography
          key={bucket}
          variant="caption"
          color={bucket === 'ask' || bucket === 'deferred' ? 'default' : 'subtle'}
          as="span"
          className={cn(styles.chip, (bucket === 'ask' || bucket === 'deferred') && styles.chipAsk)}
          data-hub-count={bucket}
          title={bucket === 'idle' ? t('chat.cascade.hub.summary.idleHint') : undefined}
        >
          {t(`chat.cascade.hub.summary.${bucket}`, { count: counts[bucket] })}
        </Typography>
      ))}
      {signals.length > 0 && (
        <Typography
          variant="caption"
          color={tone === 'info' ? 'subtle' : 'default'}
          as="span"
          className={cn(
            styles.chip,
            tone === 'alarm' && styles.chipAlarm,
            tone === 'warn' && styles.chipAsk,
          )}
          data-hub-count="signals"
          data-hub-tone={tone}
          title={t('groupWatch.summaryHint')}
        >
          {t('groupWatch.summary', { count: signals.length })}
        </Typography>
      )}
      {warm && (
        <Typography
          variant="caption"
          weight="medium"
          as="span"
          className={cn(styles.chip, warm.tone === 'saved' ? styles.chipSaved : styles.chipLost)}
          data-hub-keep-warm-total={warm.tone}
          title={t('chat.cascade.hub.summary.keepWarmHint', { count: warm.groups })}
        >
          {t(
            warm.tone === 'saved'
              ? 'chat.cascade.hub.summary.keepWarmSaved'
              : 'chat.cascade.hub.summary.keepWarmLost',
            {
              tokens: new Intl.NumberFormat(i18n.language, {
                notation: 'compact',
                maximumFractionDigits: 0,
              }).format(Math.abs(warm.saved)),
            },
          )}
        </Typography>
      )}
      {elapsedMs !== undefined && (
        <Typography variant="caption" color="subtle" as="span" data-hub-elapsed>
          {t('chat.cascade.hub.summary.elapsed', { time: formatDuration(elapsedMs, t) })}
        </Typography>
      )}
    </div>
  );
}
