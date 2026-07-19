import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import type { DeleteButtonProps } from './DeleteButton.types';

/**
 * Кнопка удаления с обязательным подтверждением. Отдельным компонентом,
 * потому что удаление есть в четырёх разделах, а забыть про диалог в одном
 * из них — значит однажды снести конфиг случайным кликом.
 */
export function DeleteButton({ entityName, description, onDelete, isPending }: DeleteButtonProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const handleConfirm = (): void => {
    onDelete();
    setIsOpen(false);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Icon name="trash" size={24} />}
        aria-label={`${t('common.delete')}: ${entityName}`}
        onClick={() => setIsOpen(true)}
      />

      <ConfirmDialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onConfirm={handleConfirm}
        title={t('common.deleteTitle')}
        description={description}
        confirmationName={entityName}
        confirmLabel={t('common.delete')}
        isPending={isPending}
      />
    </>
  );
}
