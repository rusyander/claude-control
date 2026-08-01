import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderPluginFile, useSaveProviderPluginFile } from '@entities/ProviderPlugins';
import type { ProviderPluginFileEditorProps } from './ProviderPluginFileEditor.types';
import styles from './ProviderPluginsPage.module.scss';

/**
 * Редактор ОДНОГО файла плагина. Содержимое пишется ДОСЛОВНО: это исходник
 * модуля JS/TS, панель его ничем не разбирает и ничего в нём не «улучшает».
 */
export function ProviderPluginFileEditor({
  path,
  projectId,
  onClose,
}: ProviderPluginFileEditorProps) {
  const { t } = useTranslation();
  const scope = projectId ? { projectId } : {};
  const { data, isLoading } = useProviderPluginFile(path, scope);
  const save = useSaveProviderPluginFile(scope);

  const [content, setContent] = useState<string | undefined>(undefined);

  // Переключились на другой файл — берём содержимое заново.
  useEffect(() => {
    setContent(undefined);
  }, [path]);

  useEffect(() => {
    if (data !== undefined && content === undefined) setContent(data.content);
  }, [data, content]);

  if (isLoading || !data || content === undefined) {
    return <SkeletonList rows={4} withActions={false} />;
  }

  const dirty = content !== data.content;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="mono" color="subtle" as="span" truncate>
          {data.fullPath}
        </Typography>

        <textarea
          className={styles.editor}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          aria-label={data.path}
        />

        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="caption" color="subtle">
            {t('claudeMd.chars', { count: content.length })}
            {dirty ? ` · ${t('claudeMd.unsaved')}` : ''}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={() => save.mutate({ path: data.path, content })}
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
