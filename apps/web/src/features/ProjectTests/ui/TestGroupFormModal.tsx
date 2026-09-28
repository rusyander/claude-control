import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Modal } from '@shared/ui/modal';
import { toErrorMessage } from '@shared/api/client';
import { groupFormSeed, takenGroup } from '../model/groupForm';
import type { TestGroupFormModalProps } from './TestGroupFormModal.types';

/**
 * Заведение и правка группы: идентификатор, название, описание.
 *
 * Раньше окно спрашивало только идентификатор, и группа из панели навсегда
 * получала название `SMOKE` — хук правки был, а кнопки к нему не было. Теперь то
 * же окно правит название и описание уже заведённой группы; идентификатор при
 * правке заперт: это имя файла, на него ссылаются планы и история прогонов.
 */
export function TestGroupFormModal({
  isOpen,
  onOpenChange,
  groups,
  group,
  onCreate,
  onUpdate,
}: TestGroupFormModalProps) {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isSaving, setSaving] = useState(false);

  // Окно открывается заново — поля берутся из группы (правка) или пустые.
  // Только при открытии и смене группы: опрос идущего прогона приносит новый
  // объект той же группы, и набранное название не должно стираться серверным.
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    const seed = groupFormSeed(isOpen, group);
    if (seed === seeded.current) return;
    seeded.current = seed;
    if (!seed) return;
    setId(group?.id ?? '');
    setTitle(group?.title ?? '');
    setDescription(group?.description ?? '');
    setError(undefined);
  }, [isOpen, group]);

  const save = async (): Promise<void> => {
    setError(undefined);
    const wanted = id.trim().toLowerCase();
    const taken = group ? undefined : takenGroup(groups, wanted);
    if (taken) {
      setError(t('projectTests.groupExists', { id: taken.id, title: taken.title }));
      return;
    }
    setSaving(true);
    try {
      if (group) await onUpdate(group.id, title.trim(), description.trim());
      else await onCreate(wanted, title.trim() || undefined, description.trim() || undefined);
    } catch (cause) {
      // Причина — под полем, а не только в тосте за окном: отказ (400 на
      // негодный id) иначе уходит необработанным отклонением промиса.
      setError(toErrorMessage(cause));
      return;
    } finally {
      setSaving(false);
    }
    onOpenChange(false);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t(group ? 'projectTests.editGroup' : 'projectTests.addGroup')}
      size="md"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={isSaving}
            disabled={id.trim().length === 0}
            onClick={() => void save()}
          >
            {t('projectTests.save')}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-sm)">
        <TextField
          label={t('projectTests.groupId')}
          hint={t(group ? 'projectTests.editGroupHint' : 'projectTests.groupIdHint')}
          value={id}
          onChange={(next) => {
            setId(next);
            setError(undefined);
          }}
          error={error}
          readOnly={Boolean(group)}
          autoFocus={!group}
          isMono
        />
        <TextField
          label={t('projectTests.groupTitle')}
          hint={t('projectTests.groupTitleHint')}
          value={title}
          onChange={setTitle}
          autoFocus={Boolean(group)}
        />
        <TextField
          label={t('projectTests.groupDescription')}
          value={description}
          onChange={setDescription}
          multiline
          rows={2}
        />
      </Stack>
    </Modal>
  );
}
