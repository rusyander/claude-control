import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GooseMode, GoosePermissionInfo } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { SelectField } from '@shared/ui/select-field/select-field';

/**
 * Форма прав Goose — самая короткая из всех: ОДИН корневой ключ `GOOSE_MODE`
 * файла `config.yaml`. Ни списков правил, ни второго ключа у этой модели нет,
 * поэтому вся форма это селект с пояснением выбранного режима.
 *
 * Режим `auto` подсвечивается предупреждением: в нём Goose выполняет команды и
 * правит файлы без единого вопроса — пользователь должен видеть, что выбирает.
 */

/** Черновик, который форма отдаёт наружу на сохранение. */
export interface GoosePermissionsDraft {
  mode: GooseMode;
}

export interface GoosePermissionsFormProps {
  data: GoosePermissionInfo;
  onSave: (draft: GoosePermissionsDraft) => void;
  /** Шапка раздела: своя у глобальной страницы и у таба проекта. */
  header: (state: { dirty: boolean; submit: () => void }) => React.ReactNode;
}

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
    </Stack>
  );
}
