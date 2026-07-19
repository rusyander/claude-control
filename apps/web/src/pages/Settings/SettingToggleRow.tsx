import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import type { SettingToggleRowProps } from './SettingToggleRow.types';

/** Строка настройки: название, пояснение и переключатель. */
export function SettingToggleRow({ label, hint, checked, onChange }: SettingToggleRowProps) {
  return (
    <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)">
      <Stack gap="var(--spacing-3xs)">
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
