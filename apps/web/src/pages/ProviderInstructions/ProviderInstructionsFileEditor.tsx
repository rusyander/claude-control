import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import {
  useProviderInstructionsFile,
  useSaveProviderInstructionsFile,
} from '@entities/ProviderInstructions';
import styles from './ProviderInstructionsPage.module.scss';

/**
 * Содержимое ОДНОГО файла из списка `read`. Открывается только для записи,
 * которая есть в списке и чей файл реально существует, — панель не создаёт
 * файлов, которых нет, и не открывает то, на что конфиг не ссылается.
 * Полный путь показан рядом: пользователь всегда видит, что именно правит.
 */
export function ProviderInstructionsFileEditor({
  raw,
  projectId,
}: {
  raw: string;
  projectId?: string;
}) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderInstructionsFile(raw, scope);
  const save = useSaveProviderInstructionsFile(scope);
  const [value, setValue] = useState<string | undefined>(undefined);

  // Переключились на другую запись — берём содержимое заново.
  useEffect(() => {
    setValue(undefined);
  }, [raw]);

  useEffect(() => {
    if (data !== undefined && value === undefined) setValue(data.content);
  }, [data, value]);

  if (isLoading || !data || value === undefined) {
    return <SkeletonList rows={4} withActions={false} />;
  }

  const dirty = value !== data.content;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="mono" color="subtle" as="span" truncate>
          {data.path}
        </Typography>

        <textarea
          className={styles.editor}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          aria-label={data.path}
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
              disabled={!dirty || save.isPending}
            >
              {t('claudeMd.revert')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={() => save.mutate({ path: raw, content: value })}
              isLoading={save.isPending}
              disabled={!dirty}
            >
              {t('common.save')}
            </Button>
          </Stack>
        </Stack>
      </Stack>
    </Card>
  );
}
