import { useId } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './select-field.module.scss';
import type { SelectFieldProps } from './select-field.types';

/**
 * Выбор из списка. Намеренно нативный select, а не собственный дропдаун:
 * системный список правильно работает с клавиатурой, экранными дикторами
 * и мобильными, и его не нужно чинить при каждом обновлении браузера.
 */
export function SelectField({ label, value, onChange, options, hint }: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium" as="label" htmlFor={id}>
        {label}
      </Typography>

      <select
        id={id}
        className={styles.field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? hintId : undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hint && (
        <Typography variant="caption" color="subtle" id={hintId} className={styles.hint}>
          {hint}
        </Typography>
      )}
    </Stack>
  );
}
