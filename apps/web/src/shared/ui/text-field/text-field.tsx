import { useId } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import styles from './text-field.module.scss';
import type { TextFieldProps } from './text-field.types';

/** Поле ввода с подписью и пояснением. Подпись связана с полем через id. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  rows = 6,
  isMono,
  error,
  autoFocus,
  disabled,
  type = 'text',
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  const className = [styles.field, isMono && styles.mono, error && styles.invalid]
    .filter(Boolean)
    .join(' ');

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium" as="label" htmlFor={id}>
        {label}
      </Typography>

      {multiline ? (
        <textarea
          id={id}
          className={className}
          value={value}
          rows={rows}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={Boolean(error)}
          autoFocus={autoFocus}
          disabled={disabled}
          spellCheck={false}
        />
      ) : (
        <input
          id={id}
          type={type}
          className={className}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={Boolean(error)}
          autoFocus={autoFocus}
          disabled={disabled}
          spellCheck={false}
        />
      )}

      {hint && !error && (
        <Typography variant="caption" color="subtle" id={hintId}>
          {hint}
        </Typography>
      )}
      {error && (
        <Typography variant="caption" color="danger">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
