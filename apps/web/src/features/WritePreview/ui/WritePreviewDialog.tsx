import { useTranslation } from 'react-i18next';
import type { DiffLineKind, ProviderPreviewResponse } from '@claude-control/contracts';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './WritePreviewDialog.module.scss';

/** Префикс строки диффа по её типу: как в unified diff. */
const PREFIX: Record<DiffLineKind, string> = { add: '+', del: '-', ctx: ' ' };

interface WritePreviewDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  preview: ProviderPreviewResponse | undefined;
  error: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Окно предпросмотра: что именно окажется в файле чужого CLI.
 *
 * Отказ сервера — это НЕ повод предложить «всё равно записать»: предпросмотр
 * отвергает черновик ровно теми же проверками, что и запись, поэтому кнопка
 * записи в такой ситуации просто обманывала бы. Показываем причину и оставляем
 * отмену.
 */
export function WritePreviewDialog({
  isOpen,
  isLoading,
  preview,
  error,
  onCancel,
  onConfirm,
}: WritePreviewDialogProps) {
  const { t } = useTranslation();

  const canWrite = !isLoading && !error && preview !== undefined;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => !open && onCancel()}
      title={t('writePreview.title')}
      description={preview ? preview.filePath : undefined}
      size="lg"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {canWrite && (
            <Button variant="primary" onClick={onConfirm}>
              {t('writePreview.confirm')}
            </Button>
          )}
        </Stack>
      }
    >
      {isLoading && (
        <Typography variant="body-sm" color="subtle">
          {t('writePreview.loading')}
        </Typography>
      )}

      {error && (
        <Typography variant="body-sm" color="danger">
          {t('writePreview.error')}
        </Typography>
      )}

      {preview && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" color="subtle">
            {preview.exists
              ? t('writePreview.summary', { added: preview.added, removed: preview.removed })
              : t('writePreview.willCreate')}
          </Typography>

          {preview.unchanged && (
            <Typography variant="body-sm" color="subtle">
              {t('writePreview.unchanged')}
            </Typography>
          )}

          {preview.truncated ? (
            <Typography variant="body-sm" color="subtle">
              {t('writePreview.truncated')}
            </Typography>
          ) : (
            <div className={styles.diff} aria-label={t('writePreview.title')}>
              {preview.lines.map((line, index) => (
                <div
                  // Строки диффа не имеют идентификатора; индекс здесь устойчив —
                  // список статичен и не переупорядочивается.
                  key={index}
                  className={styles.line}
                  data-kind={line.kind}
                >
                  <span className={styles.sign}>{PREFIX[line.kind]}</span>
                  <span className={styles.text}>{line.text}</span>
                </div>
              ))}
            </div>
          )}
        </Stack>
      )}
    </Modal>
  );
}
