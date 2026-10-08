import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { groupCopyName } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { toast } from '@shared/lib/toast';
import { useDuplicateGroup } from '@entities/Group';
import type { CopyGroupDialogProps } from './CopyGroupDialog.types';

/**
 * «Копировать группу»: что именно скопируется, что копия выключена и ничего
 * не гасит, и имя — предложенное «(копия)» / «(копия 2)», которое можно
 * сменить. Имя уходит на сервер готовым: какое показано, под таким и ляжет.
 * Размер `md`: у `sm` высота 320px, и первый абзац уезжал под прокрутку.
 */
export function CopyGroupDialog({ group, takenNames, onClose, onCopied }: CopyGroupDialogProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('en') ? 'en' : 'ru';
  const [name, setName] = useState(() => groupCopyName(group.name, takenNames, lang));
  const duplicate = useDuplicateGroup();

  const trimmed = name.trim();
  const isTaken = takenNames.some(
    (item) => item.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  let error: string | undefined;
  if (!trimmed) error = t('groupsPage.copy.nameRequired');
  else if (isTaken) error = t('groupsPage.copy.nameTaken');

  const submit = (): void => {
    if (error) return;
    duplicate.mutate(
      { id: group.id, name: trimmed, lang },
      {
        onSuccess: ({ group: copy }) => {
          toast.success(t('groupsPage.copy.done', { name: copy.name }));
          onCopied(copy);
        },
      },
    );
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={t('groupsPage.copy.title', { name: group.name })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('groupsPage.copy.cancel')}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={Boolean(error) || duplicate.isPending}
            isLoading={duplicate.isPending}
          >
            {t('groupsPage.copy.confirm')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <Typography variant="body-sm">{t('groupsPage.copy.description')}</Typography>
        <Typography variant="body-sm" color="muted">
          {t('groupsPage.copy.off')}
        </Typography>
        <TextField
          label={t('groupsPage.copy.name')}
          value={name}
          onChange={setName}
          error={error}
          autoFocus
        />
      </Stack>
    </Modal>
  );
}
