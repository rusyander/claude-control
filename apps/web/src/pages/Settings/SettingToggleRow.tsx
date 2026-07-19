import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import type { SettingToggleRowProps } from './SettingToggleRow.types';

/** Строка настройки: название, пояснение и переключатель. */
export function SettingToggleRow({ label, hint, checked, onChange }: SettingToggleRowProps) {
  return (
    // Переключатель прижат к правой границе карточки — так все тумблеры блока
    // стоят в одну колонку и читаются как единый столбец состояний. Ширину
    // строки не ограничиваем: иначе они выстраиваются по середине карточки.
    <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)">
      {/* Подпись ограничена по ширине строкой текста, чтобы длинное пояснение
          не тянулось через всю карточку. */}
      <Stack gap="var(--spacing-3xs)" style={{ maxWidth: 'var(--text-measure)' }}>
        <Typography variant="body-sm" as="span">
          {label}
        </Typography>
        {hint && (
          <Typography variant="caption" color="subtle" as="span">
            {hint}
          </Typography>
        )}
      </Stack>
      <Toggle checked={checked} onCheckedChange={onChange} aria-label={label} />
    </Stack>
  );
}
