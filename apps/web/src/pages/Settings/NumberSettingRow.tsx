import { useState } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { typeNumberSetting, commitNumberSetting } from './model/NumberSetting';
import type { NumberSettingRowProps } from './NumberSettingRow.types';

/**
 * Строка настройки с числом: название, пояснение и поле ввода.
 *
 * Набранное держим в своём состоянии, а не подчиняем поле сохранённому
 * значению напрямую: иначе промежуточные нажатия (а у поля с нижней границей
 * промежуточным будет любой префикс) откатывались бы обратно, и число нельзя
 * было бы напечатать вообще. Сохраняем годное сразу, остальное подтягиваем к
 * границам при уходе из поля.
 */
export function NumberSettingRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  inputClassName,
  hintClassName,
  onChange,
}: NumberSettingRowProps) {
  const [text, setText] = useState(() => String(value));
  const [savedValue, setSavedValue] = useState(value);

  // Значение пришло со стороны (сохранилось, импортировалось) — показываем его.
  if (value !== savedValue) {
    setSavedValue(value);
    setText(String(value));
  }

  const handleChange = (raw: string): void => {
    const next = typeNumberSetting(raw, { min, max });
    setText(next.text);
    if (next.value !== undefined && next.value !== value) onChange(next.value);
  };

  const handleBlur = (): void => {
    const committed = commitNumberSetting(text, { min, max }, value);
    setText(String(committed));
    if (committed !== value) onChange(committed);
  };

  return (
    <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
      <Stack gap="var(--spacing-3xs)" flex={1} minWidth="200px">
        <Typography variant="body-sm" weight="medium">
          {label}
        </Typography>
        {hint && (
          <Typography variant="caption" color="subtle" className={hintClassName}>
            {hint}
          </Typography>
        )}
      </Stack>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
        className={inputClassName}
        aria-label={label}
      />
    </Stack>
  );
}
