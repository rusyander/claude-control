import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SelectField } from '@shared/ui/select-field';
import type { RunOriginFilter } from './model/runOrigin';
import type { TestsRunsOriginFilterProps } from './TestsRunsOriginFilter.types';

/**
 * Отбор истории «Записи»: все, автотесты панели или импорт из CI. Обе последние
 * — импорт junit, и без отбора их не развести, не раскрывая записи. Ряд даёт
 * полю его собственную ширину: на всю строку выбор из трёх слов читался
 * заголовком раздела.
 */
export function TestsRunsOriginFilter({ value, onChange }: TestsRunsOriginFilterProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row">
      <SelectField
        label={t('tests.runs.origin.filter')}
        value={value}
        onChange={(next) => onChange(next as RunOriginFilter)}
        options={[
          { value: 'all', label: t('tests.runs.origin.all') },
          { value: 'e2e', label: t('tests.runs.origin.onlyE2e') },
          { value: 'ci', label: t('tests.runs.origin.onlyCi') },
        ]}
      />
    </Stack>
  );
}
