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
  // «Писал N назад» — только у идущего: у законченного время ничего не говорит.
  const quiet = view === 'running' ? elapsedMs(agent.lastActivityAt, now) : undefined;

  return (
    <li className={styles.agent} data-agent-view={view}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <StatusDot tone={AGENT_TONE[view]} pulse={view === 'running'} />
        <Typography variant="body-sm" as="span" weight="medium">
          {agent.kind}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.agentText}>
          {agent.description}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {t(`chat.progress.agentStatus.${view}`)}
          {agent.background && view === 'running' && ` · ${t('chat.progress.agentBackground')}`}
          {quiet !== undefined &&
            ` · ${t('chat.progress.agentQuiet', { ago: formatDuration(quiet, t) })}`}
        </Typography>
      </Stack>

      {agent.result && (
        <details className={styles.result}>
          <summary>{t('chat.progress.result')}</summary>
          <div className={styles.resultBody}>{agent.result}</div>
        </details>
      )}
    </li>
  );
}
