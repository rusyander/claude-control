import { useId, useLayoutEffect, useRef } from 'react';
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
  readOnly,
  type = 'text',
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);
  const isSecret = type === 'password';

  // Секрет не остаётся в РАЗМЕТКЕ. У управляемого поля React отражает `value` в
  // одноимённый атрибут, и введённый ключ оказывается в сериализованном HTML —
  // в снимке DOM, в копии страницы, в любом отчёте, куда её вложили. Снять
  // атрибут после отрисовки нельзя: React возвращает состояние управляемого
  // поля уже ПОСЛЕ эффектов, на выходе из обработчика события.
  //
  // Поэтому у парольного поля атрибута нет вовсе: значение живёт в свойстве
  // узла и синхронизируется здесь. Расхождение бывает только когда его меняет
  // не человек, а родитель (сброс формы после сохранения) — набор с клавиатуры
  // сюда не попадает, свойство к этому моменту уже равно значению.
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!isSecret || !node || node.value === value) return;
    node.value = value;
  });

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
          readOnly={readOnly}
          spellCheck={false}
        />
      ) : (
        <input
          ref={inputRef}
          id={id}
          type={type}
          className={className}
          {...(isSecret ? {} : { value })}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={Boolean(error)}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={readOnly}
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
