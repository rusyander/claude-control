import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { useResourceFile, useSaveResourceFile } from '@entities/Resource';
import { toast } from '@shared/lib/toast';
import type { ResourceFileEditorProps } from './ResourceFileEditor.types';
import styles from './ResourceFileTree.module.scss';

/**
 * Просмотр и правка одного файла ресурса. Кнопка сохранения активна только
 * когда есть что сохранять, а несохранённое помечено точкой у имени — иначе
 * непонятно, ушли правки на диск или нет.
 */
export function ResourceFileEditor({
  kind,
  id,
  file,
  isWritable,
  onClose,
}: ResourceFileEditorProps) {
  const { t } = useTranslation();
  const loaded = useResourceFile(kind, id, file);
  const save = useSaveResourceFile(kind, id);

  const [draft, setDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    setDraft(loaded.data?.content ?? '');
    setIsEditing(false);
  }, [loaded.data, file]);

  const isDirty = draft !== (loaded.data?.content ?? '');
  const isBinary = loaded.data?.isBinary ?? false;

  // Тело окна: бинарный файл только объясняем, в режиме правки даём textarea,
  // иначе показываем загруженный текст.
  const renderBody = (): ReactNode => {
    if (isBinary) {
      return (
        <div className={styles.viewerBody}>
          <Typography color="subtle">{t('resources.binaryFile')}</Typography>
        </div>
      );
    }
    if (isEditing) {
      return (
        <textarea
          className={styles.editor}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          autoFocus
        />
      );
    }
    return (
      <div className={styles.viewerBody}>{loaded.isLoading ? t('common.loading') : draft}</div>
    );
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.viewerHeader}>
        <Typography variant="mono" color="muted" as="span" truncate>
          {file}
          {isDirty && ' •'}
        </Typography>

        <Stack direction="row" align="center" gap="var(--spacing-3xs)" flexShrink={0}>
          {isEditing ? (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => save.mutate({ file, content: draft })}
                disabled={!isDirty}
                isLoading={save.isPending}
              >
                {t('common.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(loaded.data?.content ?? '');
                  setIsEditing(false);
                }}
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            isWritable &&
            !isBinary && (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Icon name="edit" size={20} />}
                aria-label={`${t('common.edit')}: ${file}`}
                onClick={() => setIsEditing(true)}
              />
            )
          )}

          {!isBinary && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="copy" size={20} />}
              aria-label={t('chat.copyArtifact')}
              onClick={() =>
                void navigator.clipboard.writeText(draft).then(() => {
                  toast.success(t('toasts.copied'));
                })
              }
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={20} />}
            aria-label={t('common.close')}
            onClick={onClose}
          />
        </Stack>
      </div>

      {renderBody()}
    </div>
  );
}
