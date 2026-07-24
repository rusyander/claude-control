import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import {
  useProviderProjectInstructions,
  useUpdateProviderProjectInstructions,
} from '@entities/Project';
import type { ProjectTabProps } from './ProjectRulesTab.types';
import styles from './ProjectsPage.module.scss';

/**
 * Файл инструкций проекта у активного провайдера (AGENTS.md у Codex/OpenCode,
 * GEMINI.md у Gemini) — целиком, как его читает сам CLI в каталоге проекта.
 * Правится как обычный текст; перед записью сервер делает резервную копию.
 */
export function ProviderProjectInstructionsTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderProjectInstructions(projectId, true);
  const update = useUpdateProviderProjectInstructions(projectId);
  const [value, setValue] = useState<string | undefined>(undefined);

  // Проект переключается — берём содержимое заново.
  useEffect(() => {
    setValue(undefined);
  }, [projectId]);

  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data.content);
  }, [data, value]);

  if (isLoading || !data || value === undefined) {
    return <SkeletonList rows={6} withActions={false} />;
  }

  const dirty = value !== data.content;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle">
          {t('providerProject.instructionsHint', { fileName: data.fileName })}
        </Typography>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {data.filePath}
        </Typography>

        <textarea
          className={styles.editor}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          aria-label={data.fileName}
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
              onClick={() => setValue(data.content)}
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
