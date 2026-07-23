import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { sourceLabel } from '@shared/lib/location-label';
import { FolderPicker } from '@features/FolderPicker';
import { useLocation, useSetLocation, useSettings, useUpdateSettings } from '@entities/AppConfig';

type Step = 'intro' | 'location';

/**
 * Приветственный мастер первого запуска. Появляется, пока пользователь не прошёл
 * онбординг ЛИБО пока каталог .claude не определён/невалиден: без рабочего
 * каталога панели нечего показывать, поэтому «Готово» до этого недоступно.
 *
 * Живёт в слое app, а не features: это сквозной gate поверх всего интерфейса,
 * который переиспользует feature FolderPicker (из features такой импорт запрещён
 * правилом no-cross-feature). После прохождения флаг onboardingDone уводит его с
 * глаз и больше не мешает.
 */
export function OnboardingWizard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data: location } = useLocation();
  const setLocation = useSetLocation();
  const updateSettings = useUpdateSettings();

  const [step, setStep] = useState<Step>('intro');
  const [pickerOpen, setPickerOpen] = useState(false);

  // Ждём и настройки, и расположение: без них не решить, показывать ли мастер.
  if (!settings || !location) return null;

  const isValid = location.isValid;
  const shouldShow = !settings.onboardingDone || !isValid;
  if (!shouldShow) return null;

  const finish = (): void => {
    updateSettings.mutate({ onboardingDone: true });
  };

  const introSummary = [t('onboarding.point1'), t('onboarding.point2'), t('onboarding.point3')];

  return (
    <>
      <Modal
        isOpen={!pickerOpen}
        // Мастер нельзя «закрыть навсегда» кликом мимо: онбординг снимается только
        // кнопкой «Готово». Пока флаг не выставлен, окно вернётся при перезагрузке.
        onOpenChange={() => undefined}
        title={step === 'intro' ? t('onboarding.introTitle') : t('onboarding.locationTitle')}
        description={
          step === 'intro' ? t('onboarding.introSubtitle') : t('onboarding.locationSubtitle')
        }
        size="md"
        footer={
          step === 'intro' ? (
            <Stack direction="row" justify="end" width="100%">
              <Button variant="primary" onClick={() => setStep('location')}>
                {t('onboarding.next')}
              </Button>
            </Stack>
          ) : (
            <Stack direction="row" justify="between" align="center" width="100%">
              <Button variant="ghost" onClick={() => setStep('intro')}>
                {t('onboarding.back')}
              </Button>
              <Button
                variant="primary"
                onClick={finish}
                disabled={!isValid}
                isLoading={updateSettings.isPending}
              >
                {t('onboarding.done')}
              </Button>
            </Stack>
          )
        }
      >
        {step === 'intro' ? (
          <Stack gap="var(--spacing-sm)">
            {introSummary.map((point) => (
              <Stack key={point} direction="row" gap="var(--spacing-xs)" align="start">
                <Icon name="check" size={18} />
                <Typography variant="body-sm">{point}</Typography>
              </Stack>
            ))}
          </Stack>
        ) : (
          <Stack gap="var(--spacing-sm)">
            <Typography variant="body-sm" color="subtle">
              {t('onboarding.locationHint')}
            </Typography>

            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Badge tone={isValid ? 'success' : 'danger'} withDot>
                {sourceLabel(location, t)}
              </Badge>
              <Typography variant="mono" color="subtle" as="span" truncate>
                {location.paths.root}
              </Typography>
            </Stack>

            {!isValid && (
              <Typography variant="body-sm" color="danger">
                {location.problem ?? t('errors.locationHint')}
              </Typography>
            )}

            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              <Button
                variant="secondary"
                leftIcon={<Icon name="folder" size={18} />}
                onClick={() => setPickerOpen(true)}
                isLoading={setLocation.isPending}
              >
                {t('onboarding.chooseFolder')}
              </Button>
            </Stack>
          </Stack>
        )}
      </Modal>

      <FolderPicker
        isOpen={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(path) => {
          setLocation.mutate(path);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
