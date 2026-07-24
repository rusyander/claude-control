import { useTranslation } from 'react-i18next';
import type { ProviderInfo } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import {
  useProviders,
  useProviderDetect,
  summarizeNavCapabilities,
  detectionBadge,
  findDetection,
  recommendedProviderId,
  activeCliHint,
} from '@entities/Provider';
import styles from './SettingsPage.module.scss';

/**
 * Выбор провайдера конфигурации. Claude — дефолт и единственный полностью
 * рабочий; прочие можно выбрать, но их разделы пока в разработке. Выбор пишет
 * настройку `provider` (PATCH settings), после чего навигация перестраивается
 * под возможности провайдера.
 *
 * Поверх этого — детект установленных CLI (Ф7): у каждого провайдера бейдж
 * «установлен» / «конфиг найден» / «не найден», у рекомендованного — бейдж
 * «рекомендуется», а если CLI АКТИВНОГО провайдера не найден — неалармирующая
 * подсказка. Детект ничего не переключает сам: дефолт остаётся claude.
 */
export function ProviderSelectorCard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data } = useProviders();
  const { data: detect } = useProviderDetect();
  const updateSettings = useUpdateSettings();

  if (!data || !settings) return <SkeletonList rows={3} withActions={false} />;

  const activeId = settings.provider;
  const isExperimentalActive = data.providers.some(
    (provider) => provider.id === activeId && provider.status === 'experimental',
  );
  const recommendedId = recommendedProviderId(detect);
  const cliHint = activeCliHint(detect);

  const select = (provider: ProviderInfo): void => {
    if (provider.id === activeId) return;
    updateSettings.mutate({ provider: provider.id });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            {t('settings.providerTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.providerHint')}
          </Typography>
        </Stack>

        {/* Заметное, но не алармирующее предупреждение при выбранном не-Claude. */}
        {isExperimentalActive && (
          <div className={styles.providerNotice}>
            <Badge tone="warning" withDot>
              {t('settings.providerExperimentalBadge')}
            </Badge>
            <Typography variant="body-sm" color="subtle">
              {t('settings.providerExperimentalNote')}
            </Typography>
          </div>
        )}

        {/* CLI активного провайдера не найден — сообщаем спокойно, без алармов:
            разделы конфигурации работают, ограничен только запуск ассистента. */}
        {cliHint && (
          <div className={styles.providerNotice}>
            <Badge tone="neutral" withDot>
              {t('providerDetect.missing')}
            </Badge>
            <Typography variant="body-sm" color="subtle">
              {t(cliHint.key, cliHint.params)}
            </Typography>
          </div>
        )}

        <Stack gap="var(--spacing-xs)">
          {data.providers.map((provider) => {
            const summary = summarizeNavCapabilities(provider.capabilities);
            const isActive = provider.id === activeId;
            const badge = detectionBadge(findDetection(detect, provider.id));
            const isRecommended = provider.id === recommendedId;
            return (
              <Card key={provider.id} padding="sm" isInteractive={!isActive}>
                <Stack
                  direction="row"
                  align="center"
                  justify="between"
                  gap="var(--spacing-sm)"
                  wrap
                >
                  <Stack gap="var(--spacing-3xs)" minWidth={0}>
                    <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                      <Typography variant="body" weight="medium" as="span">
                        {provider.name}
                      </Typography>
                      {provider.status === 'verified' ? (
                        <Badge tone="success">{t('settings.providerVerified')}</Badge>
                      ) : (
                        <Badge tone="warning">{t('settings.providerExperimental')}</Badge>
                      )}
                      {/* Бейдж детекта появляется только когда детект загружен. */}
                      {badge && <Badge tone={badge.tone}>{t(badge.key)}</Badge>}
                      {isRecommended && (
                        <Badge tone="info">{t('providerDetect.recommended')}</Badge>
                      )}
                    </Stack>
                    <Typography variant="caption" color="subtle">
                      {summary.planned > 0
                        ? t('settings.providerPreviewMixed', {
                            ready: summary.ready,
                            planned: summary.planned,
                          })
                        : t('settings.providerPreviewReady', { ready: summary.ready })}
                    </Typography>
                  </Stack>

                  <Button
                    variant={isActive ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={isActive}
                    onClick={() => select(provider)}
                  >
                    {isActive ? t('settings.providerActive') : t('settings.providerChoose')}
                  </Button>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}
