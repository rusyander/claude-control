import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { SkeletonList } from '@shared/ui/skeleton';
import {
  activeCliHint,
  detectionBadge,
  installedProviders,
  recommendedProviderId,
} from '@entities/Provider';
import type { ProvidersStepProps } from './steps.types';

/**
 * Шаг детекта CLI (Ф7): что реально нашлось в системе и кого стоит выбрать.
 * Три состояния честно различаются: «ищем», «не удалось проверить» и ответ.
 * Раньше пустой ответ и ошибка запроса выглядели одинаково — «ни один CLI не
 * найден», — и человек с рабочим `claude` читал неправду, пока шёл запрос.
 * Ничего не переключается само: провайдер меняется только нажатием.
 */
export function ProvidersStep({
  detect,
  isLoading,
  isError,
  onRetry,
  activeProviderId,
  onChoose,
  isChoosing,
}: ProvidersStepProps) {
  const { t } = useTranslation();
  const detected = installedProviders(detect);
  const recommendedId = recommendedProviderId(detect);
  const hint = activeCliHint(detect);

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="subtle">
        {t('onboarding.providersHint')}
      </Typography>

      {isLoading && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" color="subtle" role="status">
            {t('onboarding.providersLoading')}
          </Typography>
          <SkeletonList rows={2} withActions={false} />
        </Stack>
      )}

      {isError && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" color="danger">
            {t('onboarding.providersError')}
          </Typography>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </Stack>
      )}

      {detect && !isError && detected.length === 0 && (
        <Typography variant="body-sm" color="subtle">
          {t('onboarding.providersNone')}
        </Typography>
      )}

      {detect && !isError && detected.length > 0 && (
        <Stack gap="var(--spacing-xs)">
          {detected.map((provider) => {
            const badge = detectionBadge(provider);
            const isActive = provider.id === activeProviderId;
            return (
              <Stack
                key={provider.id}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-sm)"
                wrap
              >
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body-sm" weight="medium" as="span">
                    {provider.name}
                  </Typography>
                  {badge && <Badge tone={badge.tone}>{t(badge.key)}</Badge>}
                  {provider.id === recommendedId && (
                    <Badge tone="info">{t('providerDetect.recommended')}</Badge>
                  )}
                </Stack>
                {/* Кнопок «Выбрать» несколько — имя для скринридера называет провайдера. */}
                <Button
                  variant={isActive ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={isActive || isChoosing}
                  aria-label={
                    isActive
                      ? `${t('settings.providerActive')}: ${provider.name}`
                      : t('onboarding.providersChooseNamed', { name: provider.name })
                  }
                  onClick={() => onChoose(provider.id)}
                >
                  {isActive ? t('settings.providerActive') : t('onboarding.providersChoose')}
                </Button>
              </Stack>
            );
          })}
        </Stack>
      )}

      {hint && (
        <Typography variant="body-sm" color="warning">
          {t(hint.key, hint.params)}
        </Typography>
      )}

      <Typography variant="caption" color="subtle">
        {t('onboarding.providersDefaultNote')}
      </Typography>
    </Stack>
  );
}
