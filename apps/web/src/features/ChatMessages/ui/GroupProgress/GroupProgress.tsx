import { useTranslation } from 'react-i18next';
import { useChatProgress } from '@entities/Chat';
import { Typography } from '@shared/ui/typography';
import { formatAgo } from '@shared/lib/format-ago';
import { formatDuration } from '@shared/lib/format-duration';
import { useNow } from '@shared/lib/use-now';
import { groupProgress } from '../../lib/groupProgress';
import { GroupStepLine } from '../GroupStepLine/GroupStepLine';
import { HUB_POLL_MS } from '../GroupStepLine/GroupStepLine.constants';
import type { GroupProgressProps } from './GroupProgress.types';
import styles from './GroupProgress.module.scss';

/**
 * Индикатор группы в хабе (19.10.2026): состояние и сколько оно длится, шаг,
 * полоса «сделано из скольких» с процентом и вызов, которым группа занята прямо
 * сейчас, с его длительностью. Всё — из прогресса чата группы (тот же, что у
 * панели «План агента»): транскрипт приходит адресным событием, опрос — страховка.
 * Только строчные элементы: индикатор живёт внутри кнопки, открывающей чат.
 */
export function GroupProgress({ chatId, group }: GroupProgressProps) {
  const { t, i18n } = useTranslation();
  const permission = Boolean(group.awaitingPermission);
  const { data } = useChatProgress(chatId, group.isRunning || permission, HUB_POLL_MS);
  const view = groupProgress({ progress: data, group, permission });
  const now = useNow(true);
  const since = view.since ? Date.parse(view.since) : Number.NaN;
  const sinceLabel = (): string | undefined => {
    if (!Number.isFinite(since)) return undefined;
    return view.state === 'finished'
      ? formatAgo(since, now, t, i18n.language)
      : formatDuration(now - since, t);
  };
  const state = [
    t(`chat.cascade.hub.progress.state.${view.state}`),
    // Закончившей — «36 мин назад», без секунд: тикающие секунды у того, что уже
    // кончилось, только отвлекают (владелец 20.10). Идущей — длительность, как была.
    sinceLabel(),
    view.queueAhead ? t('chat.cascade.hub.progress.ahead', { count: view.queueAhead }) : undefined,
  ].filter(Boolean);
  const toolStart = view.tool?.startedAt ? Date.parse(view.tool.startedAt) : Number.NaN;
  const counted = view.percent !== undefined && view.done !== undefined && view.total;

  return (
    <span className={styles.root} data-group-progress={view.state}>
      <span className={styles.head}>
        <Typography variant="caption" as="span" className={styles.badge} data-tone={view.state}>
          {state.join(' · ')}
        </Typography>
        {view.step && <GroupStepLine step={view.step} />}
        {counted && (
          <Typography variant="caption" color="subtle" as="span" className={styles.count}>
            {t('chat.cascade.hub.progress.count', {
              done: view.done,
              total: view.total,
              percent: view.percent,
            })}
          </Typography>
        )}
      </span>
      {counted && (
        <span
          className={styles.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
          aria-label={t('chat.cascade.hub.progress.bar')}
          data-tone={view.state}
        >
          <span className={styles.fill} style={{ width: `${view.percent}%` }} />
        </span>
      )}
      {view.tool && (
        <Typography
          variant="caption"
          color="subtle"
          as="span"
          className={styles.tool}
          data-group-tool={view.tool.name}
        >
          {[
            `${view.tool.name}: ${view.tool.summary}`,
            Number.isFinite(toolStart) ? formatDuration(now - toolStart, t) : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      )}
    </span>
  );
}
