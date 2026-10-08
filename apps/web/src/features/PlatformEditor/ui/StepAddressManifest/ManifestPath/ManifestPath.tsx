import type { ManifestPathProps } from './ManifestPath.types';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { PathMode } from '../StepAddressManifest.types';
import { modeOf } from '../../../lib/modeOf';
import { Stack } from '@shared/ui/stack';
import styles from './ManifestPath.module.scss';
import { SelectField } from '@shared/ui/select-field';
import { TextField } from '@shared/ui/text-field';

/**
 * Путь или поле: как у пресета, своё, не объявлено. Режим живёт в поле, а не
 * выводится из значения: стертый до пустоты путь иначе прятал бы поле ввода
 * посреди правки, превращаясь в «не объявлено».
 */
export function ManifestPath({
  label,
  hint,
  presetValue,
  sample,
  value,
  valid,
  error,
  onChange,
}: ManifestPathProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PathMode>(() => modeOf(value));

  const pick = (next: PathMode): void => {
    setMode(next);
    if (next === 'preset') onChange(undefined);
    else if (next === 'none') onChange('');
    else onChange(value || sample);
  };

  return (
    <Stack direction="row" gap="var(--spacing-md)" wrap>
      <div className={styles.transportCell}>
        <SelectField
          label={label}
          value={mode}
          onChange={(next) => pick(next as PathMode)}
          options={[
            { value: 'preset', label: t('platform.manifest.asPreset', { value: presetValue }) },
            { value: 'custom', label: t('platform.manifest.custom') },
            { value: 'none', label: t('platform.manifest.none') },
          ]}
          hint={hint}
        />
      </div>
      {mode === 'custom' && (
        <div className={styles.transportCell}>
          <TextField
            label={t('platform.manifest.customValue', { field: label })}
            value={value ?? ''}
            onChange={(next) => onChange(next.trim())}
            placeholder={sample}
            isMono
            error={valid(value ?? '') ? undefined : error}
          />
        </div>
      )}
    </Stack>
  );
}
