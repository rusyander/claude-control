import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { useSaveProviderSkill } from '@entities/ProviderSkills';
import { skillNameError } from './skillLabels';
import type { ProviderSkillCreateFormProps } from './ProviderSkillCreateForm.types';

/**
 * Создание нового скилла. Имя становится ИМЕНЕМ ПАПКИ и путём `<имя>/SKILL.md`,
 * поэтому подчиняется задокументированной грамматике: 1–64 символа, строчные
 * латинские буквы, цифры и одиночные дефисы, не в начале и не в конце, без «--».
 * Ту же проверку делает сервер (400) — здесь предупреждаем заранее. Каталог и
 * папка появляются на диске только при сохранении.
 */
export function ProviderSkillCreateForm({
  skillsDir,
  existing,
  projectId,
  onCreated,
}: ProviderSkillCreateFormProps) {
  const { t } = useTranslation();
  const save = useSaveProviderSkill(projectId ? { projectId } : {});

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const trimmed = name.trim();
  // Та же грамматика, что на сервере (`SKILL_NAME_PATTERN`).
  const nameValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed) && trimmed.length <= 64;
  const duplicate = Boolean(trimmed) && existing.includes(trimmed);
  const descriptionEmpty = !description.trim();
  const path = trimmed ? `${trimmed}/SKILL.md` : '';

  const nameError = skillNameError({ trimmed, nameValid, duplicate }, t);

  const canCreate = Boolean(path) && nameValid && !duplicate && !descriptionEmpty;

  const create = (): void => {
    if (!canCreate) return;
    save.mutate(
      { path, name: trimmed, description, body: '' },
      {
        onSuccess: () => {
          onCreated(path);
          setName('');
          setDescription('');
        },
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm" as="h3">
          {t('providerSkills.createTitle')}
        </Typography>

        <TextField
          label={t('providerSkills.fieldName')}
          value={name}
          onChange={setName}
          placeholder="my-skill"
          isMono
          hint={t('providerSkills.hintName', { skillsDir })}
          error={nameError}
        />

        <TextField
          label={t('providerSkills.fieldDescription')}
          value={description}
          onChange={setDescription}
          hint={t('providerSkills.hintDescription')}
          placeholder={t('providerSkills.placeholderDescription')}
          error={
            descriptionEmpty && description.length > 0
              ? t('providerSkills.descriptionRequired')
              : undefined
          }
        />

        <Stack direction="row" justify="end">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="plus" size={18} />}
            disabled={!canCreate}
            isLoading={save.isPending}
            onClick={create}
          >
            {t('providerSkills.createSkill')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
