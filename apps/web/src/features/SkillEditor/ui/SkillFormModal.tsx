import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { skillApi } from '@entities/Skill';
import type { SkillFormModalProps } from './SkillFormModal.types';

/**
 * Создание и правка скилла. Описание вынесено отдельным полем и снабжено
 * пояснением: именно по нему Claude решает, когда скилл применять, — это
 * самая важная часть файла, а не его тело.
 */
export function SkillFormModal({ isOpen, onOpenChange, skill }: SkillFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  const create = skillApi.useCreate();
  const update = skillApi.useUpdate();

  useEffect(() => {
    if (!isOpen) return;
    setName(skill?.name ?? '');
    setDescription(skill?.description ?? '');
    setBody(skill?.body ?? '');
  }, [isOpen, skill]);

  const isPending = create.isPending || update.isPending;
  const canSave = name.trim().length > 0 && description.trim().length > 0 && !isPending;

  const handleSave = (): void => {
    const draft = {
      name: name.trim(),
      description: description.trim(),
      body,
      groupIds: [],
    };

    const onDone = { onSuccess: () => onOpenChange(false) };
    if (skill) update.mutate({ id: skill.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={skill ? `${t('common.edit')}: ${skill.name}` : t('skills.addSkill')}
      description={t('common.needsRestart')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind={t('skills.title')}
        fields={{ name, description, body }}
        schema={{
          name: 'Имя скилла латиницей через дефис',
          description:
            'Когда применять скилл: ситуация и слова пользователя. По этому полю Claude решает, подключать ли скилл',
          body: 'Инструкции в markdown: что делать по шагам, чего не делать, как проверить результат',
        }}
        onApply={(applied) => {
          if (typeof applied.name === 'string') setName(applied.name);
          if (typeof applied.description === 'string') setDescription(applied.description);
          if (typeof applied.body === 'string') setBody(applied.body);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('skills.skillName')}
            value={name}
            onChange={setName}
            placeholder="например: perf-audit"
            hint={t('skills.skillNameHint')}
            isMono
            autoFocus={!skill}
          />

          <TextField
            label={t('skills.description')}
            value={description}
            onChange={setDescription}
            multiline
            rows={4}
            placeholder="Use КОГДА пользователь просит…"
            hint={t('skills.descriptionHint')}
          />

          <TextField
            label={t('skills.skillBody')}
            value={body}
            onChange={setBody}
            multiline
            rows={16}
            hint={t('skills.skillBodyHint')}
          />

          {(create.isError || update.isError) && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
