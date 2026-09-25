import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { formatDuration } from '@shared/lib/format-duration';
import { triageChipState } from '../lib/triageChipState';
import type { TriageChipProps } from './TriageChip.types';
import styles from './ChildStages.module.scss';

/**
 * Итог разбора одной фишкой: идёт, не идёт, применён, не получен, оборван
 * перезапуском. Что панель в разборе поправила (потерянные задачи, снятые круги
 * ожиданий) — по наведению: это оправдание её самоуправства, а не новость, ради
 * которой стоит занимать строку.
 *
 * Оборванный разбор — отдельная подпись, а не оттенок «не получен»: там группы
 * ПОШЛИ как предложено, здесь они не пошли вовсе и ждут ответа человека.
 */
export function TriageChip({ triage, live, elapsedMs }: TriageChipProps) {
  const { t } = useTranslation();
  const state = triageChipState(triage, live);
  const label = {
    // Разбор молчит минутами (L13): время идущего прогона — прямо в фишке.
    running:
      elapsedMs === undefined
        ? t('chat.cascade.hub.triageRunning')
        : t('chat.cascade.hub.triageRunningFor', { time: formatDuration(elapsedMs, t) }),
    // Итога нет, а прогон стоит: «идёт» здесь было бы неправдой.
    stopped: t('chat.cascade.hub.triageStopped'),
    applied: t('chat.cascade.hub.triageApplied'),
    missing: t('chat.cascade.hub.triageMissing'),
    interrupted: t('chat.cascade.hub.triageInterrupted'),
  }[state];
  const repairs = triage?.repairs ?? [];

  return (
    <Typography
      variant="caption"
      color="subtle"
      as="span"
      className={styles.chip}
      data-hub-triage={state}
      title={repairs.join('\n') || undefined}
    >
      {label}
      {repairs.length > 0 ? ` · ${t('chat.cascade.hub.repairs', { count: repairs.length })}` : ''}
    </Typography>
  );
}
