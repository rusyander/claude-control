import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityRef } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { useSaveGroup } from '@entities/Group';
import { envToText, textToEnv } from '@shared/lib/env-text';
import { MemberPicker } from './MemberPicker';
import type { GroupFormModalProps } from './GroupFormModal.types';

/**
 * Создание и правка группы. Кроме состава у группы есть свои переменные
 * окружения: это позволяет держать наборы настроек и переключать их целиком,
 * не переписывая settings.json руками.
 */
export function GroupFormModal({ isOpen, onOpenChange, group }: GroupFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<EntityRef[]>([]);
  const [envText, setEnvText] = useState('');

  const saveGroup = useSaveGroup();

  useEffect(() => {
    if (!isOpen) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setMembers(group?.members ?? []);
    setEnvText(group ? envToText(group.env) : '');
  }, [isOpen, group]);

  const canSave = name.trim().length > 0 && !saveGroup.isPending;

  const handleSave = (): void => {
    saveGroup.mutate(
      {
        id: group?.id,
        draft: {
          name: name.trim(),
          description: description.trim(),
          color: group?.color ?? 'accent',
          icon: group?.icon ?? 'folder',
          members,
          env: textToEnv(envText),
          isEnabled: group?.isEnabled ?? true,
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={group ? `${t('common.edit')}: ${group.name}` : t('groups.addGroup')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            isLoading={saveGroup.isPending}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind={t('groups.title')}
        fields={{ name, description, envText }}
        schema={{
          name: 'Название группы',
          description: 'Для чего эта группа',
          envText: 'Переменные окружения группы по строке в формате KEY=VALUE',
        }}
        onApply={(applied) => {
          if (typeof applied.name === 'string') setName(applied.name);
          if (typeof applied.description === 'string') setDescription(applied.description);
          if (typeof applied.envText === 'string') setEnvText(applied.envText);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('groups.groupName')}
            value={name}
            onChange={setName}
            placeholder={t('groups.groupNamePlaceholder')}
            autoFocus={!group}
          />

          <TextField
            label={t('groups.groupDescription')}
            value={description}
            onChange={setDescription}
            multiline
            rows={2}
          />

          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('groups.membersTitle')}
            </Typography>
            <MemberPicker value={members} onChange={setMembers} />
          </Stack>

          <TextField
            label={t('groups.groupEnv')}
            value={envText}
            onChange={setEnvText}
            multiline
            rows={4}
            placeholder="KEY=VALUE"
            hint={t('groups.groupEnvHint')}
            isMono
          />

          {saveGroup.isError && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
