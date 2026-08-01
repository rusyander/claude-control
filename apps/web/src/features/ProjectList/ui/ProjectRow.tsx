import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDate } from '@shared/lib/format';
import { statusTone } from '@shared/lib/agent-runs';
import type { ProjectRowProps } from './ProjectRow.types';
import styles from './ProjectList.module.scss';

export function ProjectRow({ project, isActive, status, language, onOpen }: ProjectRowProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={[styles.item, isActive && styles.itemActive].filter(Boolean).join(' ')}
      onClick={onOpen}
      title={project.path}
    >
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <StatusDot
            tone={statusTone(status)}
            pulse={status === 'running'}
            label={status !== 'idle' ? t(`workspace.status.${status}`) : undefined}
          />
          <Icon name="folder" size={16} />
          <Typography variant="body-sm" weight="medium" as="span" truncate className={styles.name}>
            {project.name}
          </Typography>
        </Stack>

        <Typography variant="mono" color="subtle" as="span" truncate className={styles.path}>
          {project.path}
        </Typography>

        <Stack direction="row" align="center" gap="var(--spacing-3xs)">
          <Icon name="chat" size={14} />
          <Typography variant="caption" color="subtle" as="span">
            {t('projects.chats', { count: project.chats.length })}
          </Typography>
          <span className={styles.dot}>·</span>
          <Typography variant="caption" color="subtle" as="span">
            {formatDate(project.lastActivity, language)}
          </Typography>
        </Stack>
      </Stack>
    </button>
  );
}
