import type { ManifestTimeoutProps } from './ManifestTimeout.types';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { PLATFORM_MANIFEST_TIMEOUT_MAX_SEC } from '@agentdeck/contracts';
import { TextField } from '@shared/ui/text-field';
import { secondsOf } from '../../../lib/secondsOf';

/** Секунды текстом: число в управляемом поле стирало бы незаконченный ввод. */
export function ManifestTimeout({
  label,
  hint,
  presetValue,
  value,
  onChange,
}: ManifestTimeoutProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const broken = text.trim() !== '' && !/^\d+$/.test(text.trim());
  const tooLong = !broken && Number(text) > PLATFORM_MANIFEST_TIMEOUT_MAX_SEC;

  return (
    <TextField
      label={label}
      value={text}
      onChange={(next) => {
        setText(next);
        // Негодный ввод уходит в черновик негодным числом: схема его отвергнет,
        // и «Проверить связь» не сохранит контур с молча подставленной догадкой.
        onChange(secondsOf(next));
      }}
      placeholder={presetValue}
      isMono
      hint={hint(presetValue)}
      error={broken || tooLong ? t('platform.manifest.timeoutError') : undefined}
    />
  );
}
