import { useTranslation } from 'react-i18next';
import { machineStateLabel } from '@entities/CoreTask';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { formatClock, formatCount, formatUsd } from '../../model/format';
import { tokenTotal, type TimelineItem } from '../../model/items';
import { rowDetail, rowText } from '../../model/rowText';
import { CheckEntry } from '../CheckEntry/CheckEntry';
import { DecisionRow } from '../DecisionRow/DecisionRow';
import { SessionLine } from '../SessionLine/SessionLine';
import { SignalLine } from '../SignalLine/SignalLine';
import type { TimelineEntryProps } from './TimelineEntry.types';
import styles from './TimelineEntry.module.scss';

/**
 * Одна строка ленты: время, затем содержимое по виду. Номер строки журнала стоит атрибутом —
 * по нему проверка ленты ловит дубль строки после переподключения потока.
 */
export function TimelineEntry({ taskId, entry }: TimelineEntryProps) {
  const { i18n } = useTranslation();
  const { row } = entry;
  return (
    <li className={styles.entry} data-core-row={row.seq} data-core-kind={row.kind}>
      <Typography variant="caption" color="subtle" as="span" className={styles.clock}>
        {row.at > 0 ? formatClock(row.at, i18n.language) : ''}
      </Typography>
      <div className={styles.body}>
        <EntryBody taskId={taskId} entry={entry} />
      </div>
    </li>
  );
}

function EntryBody({ taskId, entry }: { taskId: string; entry: TimelineItem }) {
  const { t, i18n } = useTranslation();
  const item = entry.row.item;
  if (entry.kind === 'check' && item.type === 'decision') {
    return (
      <CheckEntry
        taskId={taskId}
        check={entry.check}
        outcome={item.outcome}
        reasons={item.reasons}
      />
    );
  }
  if (item.type === 'decision') {
    return <DecisionRow cls={item.cls} outcome={item.outcome} reasons={item.reasons} />;
  }
  if (entry.kind === 'session') {
    if (entry.session) return <SessionLine session={entry.session} spend={entry.spend} />;
  }
  const text = rowText(item);
  if (item.type === 'signal') return <SignalLine signal={item} tone={text.tone} />;
  const detail = rowDetail(item);
  return (
    <Stack gap="var(--spacing-3xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Typography
          variant="body-sm"
          weight={entry.kind === 'step' ? 'medium' : undefined}
          color={text.tone}
          as="span"
        >
          {t(text.key, text.params)}
        </Typography>
        {entry.kind === 'step' && entry.step && (
          <Badge tone="neutral">{machineStateLabel(t, 'step', entry.step.state)}</Badge>
        )}
        {entry.kind === 'step' && entry.spend && (
          <Typography variant="caption" as="span" data-step-tokens={tokenTotal(entry.spend.tokens)}>
            {t('coreTimeline.timeline.tokens', {
              tokens: formatCount(tokenTotal(entry.spend.tokens), i18n.language),
            })}
            {' · '}
            {t('coreTimeline.timeline.cost', { usd: formatUsd(entry.spend.cost.usd) })}
          </Typography>
        )}
      </Stack>
      {detail && (
        <Typography variant="caption" color="muted" lang="en" className={styles.detail}>
          {detail}
        </Typography>
      )}
      {/* Сессии шага идут своими строками ниже (со своим расходом); здесь — их число. */}
      {entry.kind === 'step' && entry.sessions.length > 0 && (
        <Typography variant="caption" color="muted" data-step-sessions={entry.sessions.length}>
          {t('coreTimeline.timeline.stepSessions', { count: entry.sessions.length })}
        </Typography>
      )}
    </Stack>
  );
}
