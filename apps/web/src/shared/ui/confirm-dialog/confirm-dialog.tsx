import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import type { ConfirmDialogProps } from './confirm-dialog.types';

/**
 * Подтверждение необратимого действия. Для удаления требуется ввести имя
 * объекта дословно: одной кнопки мало, когда удаление уносит файл скилла
 * или запись из рабочего конфига, а отмены нет.
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmationName,
  confirmLabel,
  isPending,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);

  const isConfirmed = !confirmationName || typed.trim() === confirmationName;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={!isConfirmed || isPending}
            isLoading={isPending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <Typography variant="body-sm" color="danger">
          {description}
        </Typography>

        {confirmationName && (
          <TextField
            label={t('common.confirmTypeName', { name: confirmationName })}
            value={typed}
            onChange={setTyped}
            placeholder={confirmationName}
            isMono
            autoFocus
          />
        )}
      </Stack>
    </Modal>
  );
}
