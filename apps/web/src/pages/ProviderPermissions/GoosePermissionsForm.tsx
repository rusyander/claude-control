import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GooseMode } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';
import type { GoosePermissionsFormProps } from './ProviderPermissionsForm.types';

/**
 * Форма прав Goose — самая короткая из всех: ОДИН корневой ключ `GOOSE_MODE`
 * файла `config.yaml`. Ни списков правил, ни второго ключа у этой модели нет,
 * поэтому вся форма это селект с пояснением выбранного режима.
 *
 * Режим `auto` подсвечивается предупреждением: в нём Goose выполняет команды и
 * правит файлы без единого вопроса — пользователь должен видеть, что выбирает.
 */
export function GoosePermissionsForm({ data, header, onSave }: GoosePermissionsFormProps) {
  const { t } = useTranslation();

  const [mode, setMode] = useState<GooseMode>(data.mode);

  // Синхронизируем локальную форму с сервером при загрузке/обновлении данных.
  useEffect(() => {
    setMode(data.mode);
  }, [data]);

  const dirty = mode !== data.mode;

  const modeOptions = data.modes.map((value) => ({
    value,
    label: t(`providerPermissions.goose.mode.${value}.label`),
  }));

  const submit = (): void => {
    onSave({ mode });
  };

  return (
    <Stack gap="var(--spacing-lg)">
      {header({ dirty, submit })}

      <Card padding="md">
        <Stack gap="var(--spacing-2xs)">
          <SelectField
            label={t('providerPermissions.goose.mode.label')}
            value={mode}
            onChange={(value: string) => setMode(value as GooseMode)}
            options={modeOptions}
          />
          <Typography variant="caption" color={mode === 'auto' ? 'warning' : 'subtle'}>
            {t(`providerPermissions.goose.mode.${mode}.description`)}
          </Typography>
        </Stack>
      </Card>

      {/* Пофайловые разрешения инструментов — ТОЛЬКО ПОКАЗ: формат
          `permission.yaml` в документации Goose не описан, поэтому панель его не
          пишет. Скрывать его тоже нельзя: в режимах «approve» и «smart_approve»
          именно эти списки решают, что спросят, а что выполнят молча. */}
      {data.toolPermissionsPath && (
        <Card padding="md">
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body" weight="medium" as="h3">
              {t('providerPermissions.goose.tools.title')}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('providerPermissions.goose.tools.readOnly', { path: data.toolPermissionsPath })}
            </Typography>

            {data.toolPermissions ? (
              (
                [
                  ['alwaysAllow', data.toolPermissions.alwaysAllow],
                  ['askBefore', data.toolPermissions.askBefore],
                  ['neverAllow', data.toolPermissions.neverAllow],
                ] as const
              )
                .filter(([, tools]) => tools.length > 0)
                .map(([level, tools]) => (
                  <Stack key={level} gap="var(--spacing-3xs)">
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t(`providerPermissions.goose.tools.${level}`)}
                    </Typography>
                    <Typography variant="mono" color="subtle" as="span">
                      {tools.join(', ')}
                    </Typography>
                  </Stack>
                ))
            ) : (
              <Typography variant="body-sm" color="muted">
                {t('providerPermissions.goose.tools.empty')}
              </Typography>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
