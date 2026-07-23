import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProjectRules, useUpdateProjectRules } from '@entities/Project';
import type { ProjectTabProps } from './ProjectRulesTab.types';
import styles from './ProjectsPage.module.scss';

/**
 * CLAUDE.md проекта целиком, как его читает сам Claude в каталоге проекта.
 * Правится как обычный текст; перед записью сервер делает резервную копию.
 */
export function ProjectRulesTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useProjectRules(projectId);
  const update = useUpdateProjectRules(projectId);
  const [value, setValue] = useState<string | undefined>(undefined);

  // Список проектов и содержимое переключаются — при смене проекта берём заново.
  useEffect(() => {
    setValue(undefined);
  }, [projectId]);

  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data);
  }, [data, value]);

  if (isLoading || value === undefined) return <SkeletonList rows={6} withActions={false} />;

  const dirty = value !== data;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle">
          {t('projectConfig.rulesHint')}
        </Typography>

        <textarea
          className={styles.editor}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          aria-label={t('projectConfig.tab_rules')}
        />

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="subtle">
            {t('claudeMd.chars', { count: value.length })}
            {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setValue(data)}
              disabled={!dirty || update.isPending}
            >
              {t('claudeMd.revert')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={() => update.mutate(value)}
              isLoading={update.isPending}
              disabled={!dirty}
            >
              {t('common.save')}
            </Button>
          </Stack>
        </Stack>

        <Typography variant="caption" color="subtle">
          {t('common.needsRestart')}
        </Typography>
      </Stack>
    </Card>
  );
}
