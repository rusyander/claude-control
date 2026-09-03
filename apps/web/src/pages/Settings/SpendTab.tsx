import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { PricingCard } from './PricingCard';
import { SettingToggleRow } from './SettingToggleRow';
import type { SettingsTabProps } from './SettingsTabs.types';

/**
 * Раздел «Расходы»: в чём показывать расход и по каким ставкам его считать.
 * Тарифы стоят рядом с переключателем единиц — это одно и то же решение,
 * разнесённое на две карточки только по объёму таблицы.
 */
export function SpendTab({ settings, patch }: SettingsTabProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)">
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.spendTitle')}
          </Typography>

          <SettingToggleRow
            label={t('settings.spendMoney')}
            hint={t('settings.spendHint')}
            checked={settings.costUnit === 'money'}
            onChange={(inMoney) => patch({ costUnit: inMoney ? 'money' : 'tokens' })}
          />
        </Stack>
      </Card>

      <PricingCard />
    </Stack>
  );
}
