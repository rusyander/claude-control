import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { EnvTransferExportResult, EnvTransferPreview } from './EnvTransfer.types';
import { formatArchiveSize } from './model/EnvTransferPlan';
import { EnvTransferChecklist } from './EnvTransferChecklist';
import styles from './EnvTransferCard.module.scss';

export interface EnvTransferExportModalProps {
  /** Показывается до сборки: что уедет и чего в архиве не будет. */
  preview?: EnvTransferPreview;
  /** Показывается после сборки: путь к готовому архиву. */
  result?: EnvTransferExportResult;
  isBusy: boolean;
  onChooseFolder: () => void;
  onClose: () => void;
}

/**
 * Экспорт в два шага: сначала предпросмотр (сколько файлов, откуда, что не
 * поедет), потом — выбор папки и готовый путь. Второй шаг нужен ровно затем,
 * зачем пользователь и просил кнопку: увидеть, ГДЕ лежит архив.
 */
export function EnvTransferExportModal({
  preview,
  result,
  isBusy,
  onChooseFolder,
  onClose,
}: EnvTransferExportModalProps) {
  const { t } = useTranslation();

  if (result) {
    return (
      <Modal
        isOpen
        onOpenChange={(open) => !open && onClose()}
        title={t('envTransfer.doneTitle')}
        description={t('envTransfer.doneDesc', { count: result.files })}
        size="md"
        footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      >
        <Stack gap="var(--spacing-md)">
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" color="subtle">
              {t('envTransfer.donePath')}
            </Typography>
            <Typography variant="mono" className={styles.path}>
              {result.path}
            </Typography>
            <Typography variant="body-sm" color="subtle">
              {formatArchiveSize(result.bytes)}
            </Typography>
          </Stack>
          <EnvTransferChecklist items={result.checklist} />
        </Stack>
      </Modal>
    );
  }

  if (!preview) return null;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={t('envTransfer.previewTitle', { provider: preview.provider.name })}
      description={t('envTransfer.previewDesc')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            isLoading={isBusy}
            disabled={preview.files === 0}
            leftIcon={<Icon name="folder" size={18} />}
            onClick={onChooseFolder}
          >
            {t('envTransfer.chooseFolder')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <Typography variant="body-sm">
          {preview.files === 0
            ? t('envTransfer.previewEmpty')
            : t('envTransfer.previewCount', {
                count: preview.files,
                size: formatArchiveSize(preview.bytes),
              })}
        </Typography>

        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" color="subtle">
            {t('envTransfer.previewLocations')}
          </Typography>
          {preview.locations.map((location) => (
            <Typography key={location.index} variant="mono" className={styles.path}>
              {location.path}
              {!location.exists && ` — ${t('envTransfer.locationMissing')}`}
            </Typography>
          ))}
        </Stack>

        <EnvTransferChecklist items={preview.checklist} />
      </Stack>
    </Modal>
  );
}
