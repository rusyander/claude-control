import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { useProjectRegistry } from '@entities/Project';
import type { ProjectBindingProps } from './ProjectBinding.types';
import styles from './GroupFormModal.module.scss';

/**
 * Привязка группы к проектам: набор включается сам, когда агент работает в
 * каталоге проекта.
 *
 * Список берётся из реестра проектов панели, но привязанный путь показывается и
 * тогда, когда проект из реестра убрали: иначе привязка молча исчезла бы из
 * глаз, продолжая работать на сервере.
 */
export function ProjectBinding({ value, onChange }: ProjectBindingProps) {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjectRegistry();

  const toggle = (path: string): void => {
    onChange(value.includes(path) ? value.filter((item) => item !== path) : [...value, path]);
  };

  const orphans = value.filter((path) => !projects.some((project) => project.path === path));

  return (
    <Stack gap="var(--spacing-2xs)">
      <Stack className={styles.memberList}>
        {projects.map((project) => (
          <label key={project.id} className={styles.memberRow}>
            <input
              type="checkbox"
              checked={value.includes(project.path)}
              onChange={() => toggle(project.path)}
            />
            <Typography variant="body-sm" as="span">
              {project.name}
            </Typography>
            <Typography variant="caption" color="subtle" as="span" truncate>
              {project.path}
            </Typography>
          </label>
        ))}

        {orphans.map((path) => (
          <Stack
            key={path}
            direction="row"
            align="center"
            justify="between"
            gap="var(--spacing-xs)"
            className={styles.orderRow}
          >
            <Typography variant="caption" color="subtle" as="span" truncate>
              {path}
            </Typography>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="close" size={20} />}
              onClick={() => toggle(path)}
              aria-label={t('groups.projectsRemove')}
            />
          </Stack>
        ))}

        {projects.length === 0 && orphans.length === 0 && (
          <Typography variant="body-sm" color="subtle">
            {t('groups.projectsEmpty')}
          </Typography>
        )}
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('groups.projectsHint')}
      </Typography>
    </Stack>
  );
}
