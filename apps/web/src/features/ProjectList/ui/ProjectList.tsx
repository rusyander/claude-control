import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { ProjectRow } from './ProjectRow';
import type { ProjectListProps } from './ProjectList.types';
import styles from './ProjectList.module.scss';

/**
 * Список проектов, с которыми работал Claude Code. Клик открывает проект табом
 * и начинает в нём новый разговор. Цветная точка показывает, работает ли в
 * проекте агент прямо сейчас.
 *
 * Каталогов, которых на диске уже нет, в списке нет вовсе: работать в
 * несуществующей папке негде, а строка, по которой нельзя кликнуть, — просто
 * мусор в списке. Копятся они быстро: каждая временная папка проверки остаётся
 * в истории Claude Code навсегда. Переписка при этом не пропадает — разговор
 * ищется поиском по чатам.
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

  const present = useMemo(() => projects.filter((project) => project.exists), [projects]);

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return present;
    return present.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle),
    );
  }, [present, query]);

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
          {onParallelLaunch && present.length > 0 && (
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
          {t('projects.count', { count: present.length })}
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
            onOpen={() => onOpen(project)}
          />
        ))}
      </div>
    </Stack>
  );
}
