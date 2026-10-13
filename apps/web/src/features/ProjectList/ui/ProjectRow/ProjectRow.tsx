import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { StatusDot } from '@shared/ui/status-dot';
import { statusTone } from '@shared/lib/agent-runs';
import type { ProjectRowProps } from './ProjectRow.types';
import styles from './ProjectRow.module.scss';
import { formatDate } from '../../../../shared/lib/formatDate';

/**
 * Строка проекта. Кнопка добавления на страницу «Проекты» — соседка основной
 * кнопки, а не её часть: кнопка внутри кнопки — невалидная разметка, и клик по
 * ней заодно открывал бы проект.
 */
export function ProjectRow({
  project,
  isActive,
  status,
  language,
  onOpen,
  isRegistered = false,
  onRegister,
  isRegistering = false,
}: ProjectRowProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.row}>
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
            <Typography
              variant="body-sm"
              weight="medium"
              as="span"
              truncate
              className={styles.name}
            >
              {project.name}
            </Typography>
          </Stack>

          <Typography variant="mono" color="subtle" as="span" truncate className={styles.path}>
            {project.path}
          </Typography>

          <Stack direction="row" align="center" gap="var(--spacing-3xs)">
            <Icon name="chat" size={14} />
            {project.chats.length === 0 ? (
              <Typography variant="caption" color="subtle" as="span">
                {t('chatProjects.noChats')}
              </Typography>
            ) : (
              <>
                <Typography variant="caption" color="subtle" as="span">
                  {t('projects.chats', { count: project.chats.length })}
                </Typography>
                <span className={styles.dot}>·</span>
                <Typography variant="caption" color="subtle" as="span">
                  {formatDate(project.lastActivity, language)}
                </Typography>
              </>
            )}
          </Stack>
        </Stack>
      </button>

      {isRegistered ? (
        <span
          className={styles.mark}
          role="img"
          aria-label={t('chatProjects.savedMark')}
          title={t('chatProjects.savedMark')}
        >
          <Icon name="pin" size={14} />
        </span>
      ) : (
        onRegister && (
          <button
            type="button"
            className={styles.register}
            onClick={onRegister}
            disabled={isRegistering}
            aria-label={t('chatProjects.saveRow', { name: project.name })}
            title={t('chatProjects.saveHint')}
          >
            <Icon name="plus" size={14} />
          </button>
        )
      )}
    </div>
  );
}
