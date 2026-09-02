import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { SkeletonList } from '@shared/ui/skeleton';
import { ProjectLocalConfigView, useProjectLocal } from '@entities/Project';
import type { ProjectTabProps } from './ProjectRulesTab.types';
import styles from './ProjectsPage.module.scss';

/**
 * «Из проекта»: собственный `.claude` проекта — скиллы, хуки и правила, которые
 * Claude Code загружает вместе с пользовательскими. Панель их только показывает:
 * набор принадлежит гиту проекта и правится там, поэтому вкладка без форм.
 */
export function ProjectLocalTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useProjectLocal(projectId);

  if (isLoading) return <SkeletonList rows={4} withActions={false} />;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack direction="row" align="start" gap="var(--spacing-xs)" wrap>
          <Badge tone="neutral">{t('projectLocal.readOnly')}</Badge>
          <Typography variant="caption" color="subtle" className={styles.hint}>
            {t('projectLocal.hint')}
          </Typography>
        </Stack>

        {isError || !data ? (
          <Typography variant="body-sm" color="danger">
            {t('projectLocal.loadError')}
          </Typography>
        ) : (
          <ProjectLocalConfigView config={data} />
        )}
      </Stack>
    </Card>
  );
}
