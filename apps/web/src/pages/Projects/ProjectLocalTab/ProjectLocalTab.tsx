import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { ProjectLocalConfigView, useProjectLocal } from '@entities/Project';
import { SourceLine } from '../SourceLine/SourceLine';
import type { ProjectTabProps } from '../ProjectRulesTab.types';
import styles from './ProjectLocalTab.module.scss';

/**
 * «Из проекта»: собственный `.claude` проекта — скиллы, хуки и правила, которые
 * Claude Code загружает вместе с пользовательскими. Панель их только показывает:
 * набор принадлежит гиту проекта и правится там, поэтому на вкладке нет ни одной
 * кнопки правки, а первая строка говорит «только чтение» и называет каталог.
 */
export function ProjectLocalTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProjectLocal(projectId);

  if (isLoading) return <SkeletonList rows={4} withActions={false} />;

  if (isError || !data) {
    return (
      <Typography variant="body-sm" color="danger">
        {t('projectLocal.loadError')}
      </Typography>
    );
  }

  return (
    <Stack gap="var(--spacing-md)">
      <div className={styles.sectionText}>
        <SourceLine isEditable={false} path={data.root} />
        <Typography variant="caption" color="subtle" className={styles.sectionHint}>
          {t('projectsPage.hint.local')}
        </Typography>
      </div>

      <ProjectLocalConfigView config={data} />
    </Stack>
  );
}
