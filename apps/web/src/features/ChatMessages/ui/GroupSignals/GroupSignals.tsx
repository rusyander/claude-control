import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupSignal, GroupSignalSeverity } from '@agentdeck/contracts/group-watch';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import type { GroupSignalsProps } from './GroupSignals.types';
import styles from './GroupSignals.module.scss';

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Остров «Сторож группы» в карточке хаба (фаза 2, W.4): сигналы правил по
 * живому потоку звеньев. Цвет острова — по самому важному активному сигналу;
 * строка — правило с числами, время и «Открыть чат» того звена. Закрытые
 * сигналы свёрнуты в одну строку и раскрываются по клику. Сторож только
 * наблюдает: кнопок, которые что-то останавливают, здесь нет намеренно.
 */
export function GroupSignals({ signals, onOpen }: GroupSignalsProps) {
  const { t, i18n } = useTranslation();
  const [showCleared, setShowCleared] = useState(false);
  const clearedListId = useId();
  const active = signals.filter((signal) => !signal.clearedAt);
  const cleared = signals.filter((signal) => signal.clearedAt);
  if (signals.length === 0) return null;
  const top = active.reduce<GroupSignalSeverity | undefined>(
    (worst, signal) =>
      worst === undefined || RANK[signal.severity] > RANK[worst] ? signal.severity : worst,
    undefined,
  );
  // Сигнал живёт и днями (долгая группа, закрытые): не сегодняшний — с датой.
  const time = (iso: string): string => {
    const at = new Date(iso);
    const today = at.toDateString() === new Date().toDateString();
    return at.toLocaleString(i18n.language, {
      ...(today ? {} : { day: 'numeric', month: 'short' }),
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const row = (signal: GroupSignal) => (
    <li
      key={signal.id}
      className={cn(styles.row, signal.clearedAt && styles.rowCleared)}
      data-watch-signal={signal.rule}
      data-watch-severity={signal.severity}
      {...(signal.clearedAt ? { 'data-watch-cleared': '' } : {})}
    >
      <div className={styles.rowMain}>
        <Typography
          variant="caption"
          as="span"
          className={cn(styles.badge, styles[signal.severity])}
        >
          {t(`groupWatch.severity.${signal.severity}`)}
        </Typography>
        <Typography variant="body-sm" as="span" className={styles.text}>
          {t(signal.textKey, signal.numbers)}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.time}>
          {signal.clearedAt
            ? t('groupWatch.clearedAt', { time: time(signal.clearedAt) })
            : time(signal.at)}
        </Typography>
        {onOpen && !signal.clearedAt && (
          <Button
            size="sm"
            variant="ghost"
            className={styles.open}
            data-watch-open
            onClick={() => onOpen(signal.chatId)}
          >
            {t('groupWatch.openChat')}
          </Button>
        )}
      </div>
      {signal.params &&
        Object.entries(signal.params).map(([key, value]) => (
          <Typography key={key} variant="mono" color="subtle" as="div" className={styles.param}>
            {t(`groupWatch.param.${key}`, { value })}
          </Typography>
        ))}
    </li>
  );

  return (
    <div
      className={cn(styles.island, top && styles[`island-${top}`])}
      data-group-watch={active.length}
      title={t('groupWatch.islandHint')}
    >
      <Typography variant="caption" as="div" className={styles.title}>
        {t('groupWatch.island')}
      </Typography>
      {active.length > 0 && <ul className={styles.list}>{active.map(row)}</ul>}
      {cleared.length > 0 && (
        <>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={showCleared}
            aria-controls={clearedListId}
            data-watch-cleared-toggle
            onClick={() => setShowCleared((open) => !open)}
          >
            {t('groupWatch.cleared', { count: cleared.length })}
          </button>
          {showCleared && (
            <ul id={clearedListId} className={styles.list}>
              {cleared.map(row)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
