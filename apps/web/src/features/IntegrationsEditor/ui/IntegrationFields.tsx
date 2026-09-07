import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { INTEGRATION_FIELDS } from '../model/draft';
import type { IntegrationFieldsProps } from './IntegrationFields.types';

/**
 * Поля одной карточки, нарисованные по описанию.
 *
 * Подписи и подсказки берутся по ключу поля — так словарь остаётся
 * единственным местом, где написано, что человек должен сюда вписать, и новое
 * поле нельзя добавить, забыв его объяснить.
 */
export function IntegrationFields({ id, draft, onChange, missing }: IntegrationFieldsProps) {
  const { t } = useTranslation();

  return (
    <Stack direction="row" gap="var(--spacing-xs)" wrap align="start">
      {INTEGRATION_FIELDS[id].map((field) => {
        const label = t(`integrations.field.${id}.${field.key}`);
        const hint = t(`integrations.hint.${id}.${field.key}`);
        const error = missing.includes(field.key)
          ? t('integrations.card.fieldRequired')
          : undefined;

        if (field.kind === 'select') {
          return (
            <Stack key={field.key} flex={1} minWidth="200px">
              <SelectField
                label={label}
                value={draft[field.key] ?? ''}
                onChange={(value) => onChange(field.key, value)}
                hint={hint}
                options={(field.options ?? []).map((option) => ({
                  value: option,
                  label: option
                    ? t(`integrations.option.${id}.${field.key}.${option}`)
                    : t('integrations.option.unset'),
                }))}
              />
            </Stack>
          );
        }

        return (
          <Stack key={field.key} flex={1} minWidth="200px">
            <TextField
              label={label}
              value={draft[field.key] ?? ''}
              onChange={(value) => onChange(field.key, value)}
              hint={hint}
              error={error}
            />
          </Stack>
        );
      })}
    </Stack>
  );
}
