import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import type { AgentRowProps } from '../ChatProgressSheet.types';
import styles from './AgentRow.module.scss';
import { AGENT_TONE } from './AgentRow.constants';

export function AgentRow({ agent }: AgentRowProps) {
  const { t } = useTranslation();
  const tone = AGENT_TONE[agent.status];

  return (
    <li className={styles.agent}>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)">
        <StatusDot tone={tone} pulse={agent.status === 'running'} />
        <Typography variant="body-sm" as="span" weight="medium">
          {agent.kind}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.agentText}>
          {agent.description}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {t(`chat.progress.agentStatus.${agent.status}`)}
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
