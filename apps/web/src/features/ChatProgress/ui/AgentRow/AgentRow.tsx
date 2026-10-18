import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDuration } from '@shared/lib/format-duration';
import type { AgentRowProps } from '../ChatProgressSheet.types';
import styles from './AgentRow.module.scss';
import { AGENT_TONE } from './AgentRow.constants';
import { agentView } from '../../model/agentView';
import { elapsedMs } from '../../model/elapsedMs';

export function AgentRow({ agent, isRunning, processAlive, now }: AgentRowProps) {
  const { t } = useTranslation();
  const view = agentView(agent, isRunning, processAlive);
  const running = view === 'running';
  // «Писал N назад» — только у идущего: у законченного время ничего не говорит.
  const quiet = running ? elapsedMs(agent.lastActivityAt, now) : undefined;
  // Что субагент делает сейчас и сколько уже — живое ревью 18.10: строка
  // говорила «работает», пока полоса 26 минут ждала одну проверку.
  const total = running ? elapsedMs(agent.startedAt, now) : undefined;
  const activity = running ? agent.activity : undefined;
  const activityFor = activity ? elapsedMs(activity.startedAt, now) : undefined;
  const what = activity ? [activity.name, activity.summary].filter(Boolean).join(': ') : '';

  return (
    <li className={styles.agent} data-agent-view={view}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <StatusDot tone={AGENT_TONE[view]} pulse={running} />
        <Typography variant="body-sm" as="span" weight="medium">
          {agent.kind}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.agentText}>
          {agent.description}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {t(`chat.progress.agentStatus.${view}`)}
          {agent.background && running && ` · ${t('chat.progress.agentBackground')}`}
          {total !== undefined &&
            ` · ${t('chat.progress.agentTotal', { for: formatDuration(total, t) })}`}
          {quiet !== undefined &&
            ` · ${t('chat.progress.agentQuiet', { ago: formatDuration(quiet, t) })}`}
        </Typography>
      </Stack>

      {activity && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          className={styles.activity}
          data-agent-activity={activity.waiting ? 'waiting' : 'working'}
        >
          {activity.waiting && (
            <span className={styles.waiting}>{t('chat.progress.agentWaiting')}</span>
          )}
          <Typography variant="caption" color="subtle" as="span" className={styles.activityText}>
            {activityFor !== undefined
              ? t('chat.progress.agentNow', { what, for: formatDuration(activityFor, t) })
              : what}
          </Typography>
        </Stack>
      )}

      {agent.result && (
        <details className={styles.result}>
          <summary>{t('chat.progress.result')}</summary>
          <div className={styles.resultBody}>{agent.result}</div>
        </details>
      )}
    </li>
  );
}
