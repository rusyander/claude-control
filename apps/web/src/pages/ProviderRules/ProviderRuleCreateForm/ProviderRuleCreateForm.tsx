import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { Toggle } from '@shared/ui/toggle';
import { useSaveProviderRule } from '@entities/ProviderRules';
import { rulePathError } from '../ruleLabels';
import type { ProviderRuleCreateFormProps } from './ProviderRuleCreateForm.types';
import { ruleFormat } from '../ruleFormat';

/**
 * Создание нового правила `.mdc`. Путь задаётся ОТНОСИТЕЛЬНО каталога правил —
 * подкаталоги разрешены (`frontend/react.mdc`) и появятся на диске только при
 * сохранении. Расширение формата (`.mdc` у Cursor, `.md` у Continue и Qwen)
 * дописывается само: файл с другим расширением CLI не прочитает, и сервер такой
 * путь отклонит. У Qwen нет `alwaysApply` — переключателя в форме нет.
 */
export function ProviderRuleCreateForm({
  rulesDir,
  format,
  existing,
  projectId,
  onCreated,
}: ProviderRuleCreateFormProps) {
  const { t } = useTranslation();
  const traits = ruleFormat(format);
  const save = useSaveProviderRule(projectId ? { projectId } : {});

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [globs, setGlobs] = useState('');
  const [alwaysApply, setAlwaysApply] = useState(false);

  const trimmed = name.trim().replace(/^[/\\]+/, '');
  const path =
    trimmed && !trimmed.toLowerCase().endsWith(traits.extension)
      ? `${trimmed}${traits.extension}`
      : trimmed;
  const duplicate = Boolean(path) && existing.includes(path);
  // Выход за каталог сервер отклонит в любом случае — предупреждаем заранее.
  const unsafe = /(^|[/\\])\.\.([/\\]|$)/.test(trimmed) || /^([/\\]|[A-Za-z]:)/.test(trimmed);

  const create = (): void => {
    if (!path || duplicate || unsafe) return;
    save.mutate(
      {
        path,
        description,
        globs,
        ...(traits.alwaysApply ? { alwaysApply } : {}),
        body: '',
      },
      {
        onSuccess: () => {
          onCreated(path);
          setName('');
          setDescription('');
          setGlobs('');
          setAlwaysApply(false);
        },
      },
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm" as="h3">
          {t('providerRules.createTitle')}
        </Typography>

        <TextField
          label={t('providerRules.fieldPath')}
          value={name}
          onChange={setName}
          placeholder={`frontend/react${traits.extension}`}
          isMono
          hint={t(traits.text('hintPath'), { rulesDir })}
          error={rulePathError(duplicate, unsafe, t)}
        />

        <TextField
          label={t('providerRules.fieldDescription')}
          value={description}
          onChange={setDescription}
          hint={t(traits.text('hintDescription'))}
          placeholder={t('providerRules.placeholderDescription')}
        />

        <TextField
          label={t(traits.text('fieldGlobs'))}
          value={globs}
          onChange={setGlobs}
          hint={t(traits.text('hintGlobs'))}
          placeholder="src/**/*.tsx, src/**/*.ts"
          isMono
        />

        {traits.alwaysApply && (
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
            <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
              <Typography variant="body-sm">{t('providerRules.fieldAlwaysApply')}</Typography>
              <Typography variant="caption" color="subtle">
                {t('providerRules.hintAlwaysApply')}
              </Typography>
            </Stack>
            <Toggle
              checked={alwaysApply}
              onCheckedChange={setAlwaysApply}
              aria-label={t('providerRules.fieldAlwaysApply')}
            />
          </Stack>
        )}

        <Stack direction="row" justify="end">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="plus" size={18} />}
            disabled={!path || duplicate || unsafe}
            isLoading={save.isPending}
            onClick={create}
          >
            {t('providerRules.createRule')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
