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

/**
 * Создание нового правила `.mdc`. Путь задаётся ОТНОСИТЕЛЬНО каталога правил —
 * подкаталоги разрешены (`frontend/react.mdc`) и появятся на диске только при
 * сохранении. Расширение `.mdc` дописывается автоматически: файл с другим
 * расширением Cursor просто не прочитает, и сервер такой путь отклонит.
 */
export function ProviderRuleCreateForm({
  rulesDir,
  existing,
  projectId,
  onCreated,
}: {
  rulesDir: string;
  existing: string[];
  projectId?: string;
  onCreated: (path: string) => void;
}) {
  const { t } = useTranslation();
  const save = useSaveProviderRule(projectId ? { projectId } : {});

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [globs, setGlobs] = useState('');
  const [alwaysApply, setAlwaysApply] = useState(false);

  const trimmed = name.trim().replace(/^[/\\]+/, '');
  const path = trimmed && !/\.mdc$/i.test(trimmed) ? `${trimmed}.mdc` : trimmed;
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
        alwaysApply,
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
          placeholder="frontend/react.mdc"
          isMono
          hint={t('providerRules.hintPath', { rulesDir })}
          error={
            duplicate
              ? t('providerRules.duplicate')
              : unsafe
                ? t('providerRules.unsafePath')
                : undefined
          }
        />

        <TextField
          label={t('providerRules.fieldDescription')}
          value={description}
          onChange={setDescription}
          hint={t('providerRules.hintDescription')}
          placeholder={t('providerRules.placeholderDescription')}
        />

        <TextField
          label={t('providerRules.fieldGlobs')}
          value={globs}
          onChange={setGlobs}
          hint={t('providerRules.hintGlobs')}
          placeholder="src/**/*.tsx, src/**/*.ts"
          isMono
        />

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
