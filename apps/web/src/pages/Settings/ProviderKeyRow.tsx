import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { useSaveProviderKey, useClearProviderKey } from '@entities/ProviderKeys';
import { KEY_STATUS_TONE } from './ProviderKeyRow.constants';
import { keyStatusLabel } from './ProviderKeyRow.lib';
import type { ProviderKeyRowProps } from './ProviderKeyRow.types';

/** Одна строка провайдера: статус ключа + поле ввода + сохранить/очистить. */
export function ProviderKeyRow({ item }: ProviderKeyRowProps) {
  const { t } = useTranslation();
  const save = useSaveProviderKey();
  const clear = useClearProviderKey();
  const [value, setValue] = useState('');

  const status = item.keyStatus;
  const statusLabel = keyStatusLabel(status, t);
  const statusTone = KEY_STATUS_TONE[status.source ?? 'none'];

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    save.mutate({ providerId: item.providerId, key: trimmed }, { onSuccess: () => setValue('') });
  };

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body-sm" weight="medium" as="span">
              {item.providerName}
            </Typography>
            <Badge tone="neutral">{t(`providerKeys.apiKind.${item.apiKind}`)}</Badge>
          </Stack>
          <Badge tone={statusTone} withDot>
            {statusLabel}
          </Badge>
        </Stack>

        {/* Подсказка про переменные окружения вынесена ПОД строку, а не в hint
            поля: внутри поля она удлиняет его блок, и кнопки, выровненные по
            низу строки, уезжают ниже самого инпута. Снаружи низ поля и низ
            кнопок совпадают при любой длине подсказки. */}
        <Stack gap="var(--spacing-2xs)">
          <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
            <Stack flex={1} minWidth="220px">
              <TextField
                label={t('providerKeys.inputLabel', { provider: item.providerName })}
                type="password"
                value={value}
                onChange={setValue}
                placeholder={t('providerKeys.inputPlaceholder')}
              />
            </Stack>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="check" size={18} />}
              onClick={submit}
              disabled={!value.trim()}
              isLoading={save.isPending}
            >
              {t('common.save')}
            </Button>
            {status.source === 'stored' && (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="trash" size={18} />}
                onClick={() => clear.mutate(item.providerId)}
                isLoading={clear.isPending}
              >
                {t('providerKeys.clear')}
              </Button>
            )}
          </Stack>
          {item.envVars.length > 0 && (
            <Typography variant="caption" color="subtle">
              {t('providerKeys.envHint', { vars: item.envVars.join(', ') })}
            </Typography>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
