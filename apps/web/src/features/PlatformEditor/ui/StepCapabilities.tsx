import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { CapabilityMatrix } from '@entities/Platform';
import type { WizardStepProps } from './PlatformWizard.types';

/**
 * Шаг 3 — что панель СПРОСИЛА у контура. Не что она умеет и не что обещает
 * платформа: строки заполняет ответ на этом адресе с этим ключом.
 *
 * Отказ пробы не запирает мастер: контур можно досоздать и проверить позже —
 * запертый на недоступном контуре человек всё равно уйдёт правкой файла руками.
 */
export function StepCapabilities({ model }: WizardStepProps) {
  const { t } = useTranslation();
  const probe = model.probe;

  return (
    <Stack gap="var(--spacing-md)">
      {probe ? (
        <>
          <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between" wrap>
            <Typography variant="body-sm">
              {t(`platform.outcome.${probe.outcome}`)} · {probe.detail}
            </Typography>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void model.probeNow()}
              disabled={model.isBusy}
              isLoading={model.isProbing}
            >
              {t('platform.checkAgain')}
            </Button>
          </Stack>

          {probe.capabilities.length > 0 && <CapabilityMatrix findings={probe.capabilities} />}

          {probe.models.length > 0 && (
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" weight="medium" as="h3">
                {t('platform.modelsTitle', { count: probe.models.length })}
              </Typography>
              {/* Список ключа — главная ценность контура: показываем ровно то,
                  чем можно пользоваться, а не общий каталог платформы. */}
              <Typography variant="caption" color="muted">
                {probe.models
                  .slice(0, 12)
                  .map((model) => model.id)
                  .join(', ')}
                {probe.models.length > 12 ? ' …' : ''}
              </Typography>
            </Stack>
          )}

          {probe.notes.map((note) => (
            <Typography key={note} variant="caption" color="muted">
              {note}
            </Typography>
          ))}
        </>
      ) : (
        <EmptyState
          icon="plug"
          title={t('platform.notCheckedTitle')}
          text={t('platform.notCheckedText')}
          action={
            <Button
              variant="secondary"
              onClick={() => void model.probeNow()}
              disabled={!model.isValid || model.isBusy}
              isLoading={model.isProbing}
            >
              {t('platform.checkConnection')}
            </Button>
          }
        />
      )}
    </Stack>
  );
}
