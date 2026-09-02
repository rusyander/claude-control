import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { statusTone } from '@shared/lib/agent-runs';
import { formatSpend } from '@shared/lib/format';
import { projectName } from '@entities/Project';
import type { AgentRowProps } from './AgentsPanel.types';
import styles from './AgentsPanel.module.scss';

export function AgentRow({ run, costUnit, statusLabel, chatLabel, onOpen, onStop }: AgentRowProps) {
  const { t } = useTranslation();
  const spent =
    run.tokens || run.costUsd ? formatSpend(costUnit, run.tokens ?? 0, run.costUsd ?? 0) : '';

  return (
    <Stack
      direction="row"
      align="center"
      gap="var(--spacing-2xs)"
      padding="var(--spacing-3xs) var(--spacing-2xs) var(--spacing-3xs) var(--spacing-sm)"
      className={styles.row}
    >
      <button type="button" className={styles.rowMain} onClick={onOpen} title={run.projectPath}>
        {/* Активные прогоны пульсируют: работает — виден, ждёт/упал — зовёт.
            Молчащий стоит ровно: событий нет — и движения нет. */}
        <StatusDot tone={statusTone(run.status)} pulse={run.status !== 'quiet'} />

        <Stack gap="0" className={styles.rowText}>
          <Typography variant="body-sm" as="span" truncate>
            {projectName(run.projectPath, chatLabel)}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {statusLabel}
            {spent ? ` · ${spent}` : ''}
          </Typography>
        </Stack>
      </button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Icon name="stop" size={18} />}
        aria-label={t('chat.stop')}
        onClick={onStop}
      />
    </Stack>
  );
}
