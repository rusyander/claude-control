import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { PLATFORM_BASE_URL_SAMPLE, PLATFORM_DRIVERS, validatePlatform } from '@entities/Platform';
import type { WizardStepProps } from './PlatformWizard.types';

/**
 * Шаг 1 — адрес. Здесь же живая проверка связи, и это не украшение: самая
 * частая ошибка настройки — адрес админки вместо адреса API, и узнать о ней
 * лучше на первом шаге, а не после ввода ключа.
 *
 * Проверку делает сервер, поэтому она сначала СОХРАНЯЕТ черновик. Контур
 * остаётся выключенным до последнего шага — сохранённый черновик ничего не
 * применяет и сам никуда не ходит.
 */
export function StepAddress({ model }: WizardStepProps) {
  const { t } = useTranslation();
  const errors = validatePlatform(model.draft);
  const probe = model.probe;

  return (
    <Stack gap="var(--spacing-md)">
      <SelectField
        label={t('platform.driverLabel')}
        value={model.draft.driver}
        onChange={(value) => model.patch({ driver: value as (typeof PLATFORM_DRIVERS)[number] })}
        options={PLATFORM_DRIVERS.map((driver) => ({
          value: driver,
          label: t(`platform.driver.${driver}`),
        }))}
        hint={t(`platform.driverHint.${model.draft.driver}`)}
      />

      <TextField
        label={t('platform.titleLabel')}
        value={model.draft.title}
        onChange={(value) => model.patch({ title: value })}
        placeholder={t('platform.titlePlaceholder')}
        error={errors.title ? t('platform.error.title_required') : undefined}
        autoFocus
      />

      <TextField
        label={t('platform.idLabel')}
        value={model.draft.id}
        onChange={model.setId}
        isMono
        hint={t('platform.idHint')}
        error={errors.id ? t(`platform.error.id_${errors.id}`) : undefined}
      />

      <TextField
        label={t('platform.baseUrlLabel')}
        value={model.draft.baseUrl}
        onChange={(value) => model.patch({ baseUrl: value })}
        placeholder={PLATFORM_BASE_URL_SAMPLE[model.draft.driver]}
        isMono
        hint={t('platform.baseUrlHint')}
        error={errors.baseUrl ? t(`platform.error.baseUrl_${errors.baseUrl}`) : undefined}
      />

      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void model.probeNow()}
            disabled={!model.isValid || model.isBusy}
            isLoading={model.isProbing}
          >
            {t('platform.checkConnection')}
          </Button>
          {probe && (
            <Stack direction="row" gap="var(--spacing-2xs)" align="center">
              <StatusDot tone={probe.outcome === 'ok' ? 'success' : 'warning'} />
              <Typography variant="body-sm" as="span">
                {t(`platform.outcome.${probe.outcome}`)}
              </Typography>
            </Stack>
          )}
        </Stack>
        <Typography variant="caption" color="muted">
          {t('platform.checkSavesDraft')}
        </Typography>
        {probe && (
          <Typography variant="caption" color="muted">
            {probe.detail}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
