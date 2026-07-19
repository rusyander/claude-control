import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { MatcherPickerProps } from './MatcherPicker.types';
import styles from './HookFormModal.module.scss';

/**
 * Выбор нескольких инструментов вместо написания регулярного выражения руками.
 * В конфиг они уйдут объединёнными через вертикальную черту — синтаксис,
 * который понимает Claude Code, но помнить его пользователю не нужно.
 */
export function MatcherPicker({ value, onChange, suggestions }: MatcherPickerProps) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState('');

  const toggle = (item: string): void => {
    onChange(value.includes(item) ? value.filter((entry) => entry !== item) : [...value, item]);
  };

  const addCustom = (): void => {
    const trimmed = custom.trim();
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed]);
    setCustom('');
  };

  return (
    <Stack gap="var(--spacing-2xs)">
      <Typography variant="body-sm" weight="medium" as="span">
        {t('hooks.matcher')}
      </Typography>

      <Stack direction="row" gap="var(--spacing-2xs)" wrap>
        {suggestions.map((item) => (
          <Button
            key={item}
            size="sm"
            variant={value.includes(item) ? 'primary' : 'secondary'}
            onClick={() => toggle(item)}
          >
            {item}
          </Button>
        ))}
      </Stack>

      {/* Своё значение: инструментов больше, чем в списке подсказок. */}
      <Stack direction="row" gap="var(--spacing-2xs)" align="center">
        <input
          className={styles.customInput}
          value={custom}
          onChange={(input) => setCustom(input.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Enter') {
              keyEvent.preventDefault();
              addCustom();
            }
          }}
          placeholder={t('hooks.customMatcher')}
          aria-label={t('hooks.customMatcher')}
        />
        <Button
          size="sm"
          iconOnly
          icon={<Icon name="plus" size={24} />}
          aria-label={t('common.create')}
          onClick={addCustom}
          disabled={!custom.trim()}
        />
      </Stack>

      {value.length > 0 && (
        <Stack direction="row" gap="var(--spacing-2xs)" wrap align="center">
          {value.map((item) => (
            <Badge key={item} tone="accent">
              {item}
            </Badge>
          ))}
          <Typography variant="caption" color="subtle" as="span">
            → {value.join('|')}
          </Typography>
        </Stack>
      )}

      <Typography variant="caption" color="subtle">
        {t('hooks.matcherHint')}
      </Typography>
    </Stack>
  );
}
