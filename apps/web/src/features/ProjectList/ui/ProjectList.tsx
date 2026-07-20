import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { StatusDot } from '@shared/ui/status-dot';
import { formatDate } from '@shared/lib/format';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { statusTone } from '@shared/lib/agent-runs';
import type { ProjectListProps, ProjectRowProps } from './ProjectList.types';
import styles from './ProjectList.module.scss';

/**
 * Список проектов, с которыми работал Claude Code. Клик открывает проект табом
 * и начинает в нём новый разговор. Существующие каталоги — сверху; исчезнувшие с
 * диска помечаем и открыть не даём: работать в несуществующей папке негде.
 * Цветная точка показывает, работает ли в проекте агент прямо сейчас.
 */
export function ProjectList({
  projects,
  isLoading,
  activeId,
  statuses,
  onOpen,
  onAddFolder,
  onParallelLaunch,
}: ProjectListProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle),
    );
  }, [projects, query]);

  return (
    <Stack className={styles.panel}>
      <Stack gap="var(--spacing-xs)" className={styles.header}>
        {/*
          Кнопки идут в столбик, а не в строку: панель шириной 300px, и два
          полноразмерных действия с подписями в неё не помещаются — вторая
          кнопка вылезала за край панели. Сокращать подписи до «Папка» и
          «Мульти-запуск» пришлось бы сильнее, чем это читаемо.
        */}
        <Stack gap="var(--spacing-2xs)">
          {onAddFolder && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="plus" size={20} />}
              onClick={onAddFolder}
              fullWidth
            >
              {t('projects.addFolder')}
            </Button>
          )}
          {onParallelLaunch && projects.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="send" size={20} />}
              onClick={onParallelLaunch}
              fullWidth
            >
              {t('parallel.button')}
            </Button>
          )}
        </Stack>
        <SearchField
          label={t('projects.search')}
          value={query}
          onChange={setQuery}
          placeholder={t('projects.searchPlaceholder')}
        />
        <Typography variant="caption" color="subtle">
          {t('projects.count', { count: projects.length })}
        </Typography>
      </Stack>

      <div className={styles.items}>
        {isLoading && <SkeletonList rows={6} withActions={false} />}

        {!isLoading && found.length === 0 && (
          <EmptyState
            icon="folder"
            title={t('projects.emptyTitle')}
            text={t('projects.emptyText')}
          />
        )}

        {found.map((project) => (
          <ProjectRow
            key={project.path}
            project={project}
            isActive={normalizeProjectPath(project.path) === activeId}
            status={statuses?.get(normalizeProjectPath(project.path)) ?? 'idle'}
            language={i18n.language}
            onOpen={() => project.exists && onOpen(project)}
          />
        ))}
      </div>
    </Stack>
  );
}

function ProjectRow({ project, isActive, status, language, onOpen }: ProjectRowProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={[styles.item, isActive && styles.itemActive, !project.exists && styles.itemGone]
        .filter(Boolean)
        .join(' ')}
      onClick={onOpen}
      disabled={!project.exists}
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
          {!project.exists && <Badge tone="warning">{t('projects.missing')}</Badge>}
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
