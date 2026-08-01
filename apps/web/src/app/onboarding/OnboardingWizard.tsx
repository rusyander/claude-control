import { useState } from 'react';
import type { ReactNode } from 'react';
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
import {
  useProviderDetect,
  installedProviders,
  recommendedProviderId,
  detectionBadge,
} from '@entities/Provider';
import type { Step } from './OnboardingWizard.types';

/**
 * Приветственный мастер первого запуска. Появляется, пока пользователь не прошёл
 * онбординг ЛИБО пока каталог .claude не определён/невалиден: без рабочего
 * каталога панели нечего показывать, поэтому «Готово» до этого недоступно.
 *
 * Живёт в слое app, а не features: это сквозной gate поверх всего интерфейса,
 * который переиспользует feature FolderPicker (из features такой импорт запрещён
 * правилом no-cross-feature). После прохождения флаг onboardingDone уводит его с
 * глаз и больше не мешает.
 *
 * Третий шаг — детект провайдеров (Ф7): панель показывает, какие CLI реально
 * нашлись в системе, и даёт выбрать провайдера одним нажатием. Шаг НЕ обязателен
 * («Готово» доступно и без выбора) и ничего не переключает сам: дефолт остаётся
 * claude, детект — подсказка.
 */
export function OnboardingWizard() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data: location } = useLocation();
  const { data: detect } = useProviderDetect();
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

  // Детект (Ф7): что реально нашлось в системе и кого стоит порекомендовать.
  // Ничего не переключаем автоматически — провайдер меняется только нажатием.
  const detected = installedProviders(detect);
  const recommendedId = recommendedProviderId(detect);
  const activeProviderId = settings.provider;

  const titles: Record<Step, string> = {
    intro: t('onboarding.introTitle'),
    location: t('onboarding.locationTitle'),
    providers: t('onboarding.providersTitle'),
  };
  const descriptions: Record<Step, string> = {
    intro: t('onboarding.introSubtitle'),
    location: t('onboarding.locationSubtitle'),
    providers: t('onboarding.providersSubtitle'),
  };

  // Кнопки и содержимое расписаны по шагам теми же таблицами, что заголовки:
  // мастер линейный, и каждый шаг виден целиком, без ветвлений внутри разметки.
  const footers: Record<Step, ReactNode> = {
    intro: (
      <Stack direction="row" justify="end" width="100%">
        <Button variant="primary" onClick={() => setStep('location')}>
          {t('onboarding.next')}
        </Button>
      </Stack>
    ),
    location: (
      <Stack direction="row" justify="between" align="center" width="100%">
        <Button variant="ghost" onClick={() => setStep('intro')}>
          {t('onboarding.back')}
        </Button>
        {/* Дальше — только с рабочим каталогом: без него панели нечего показывать. */}
        <Button variant="primary" onClick={() => setStep('providers')} disabled={!isValid}>
          {t('onboarding.next')}
        </Button>
      </Stack>
    ),
    providers: (
      <Stack direction="row" justify="between" align="center" width="100%">
        <Button variant="ghost" onClick={() => setStep('location')}>
          {t('onboarding.back')}
        </Button>
        {/* Шаг необязательный: «Готово» доступно и без выбора провайдера. */}
        <Button
          variant="primary"
          onClick={finish}
          disabled={!isValid}
          isLoading={updateSettings.isPending}
        >
          {t('onboarding.done')}
        </Button>
      </Stack>
    ),
  };

  const bodies: Record<Step, ReactNode> = {
    intro: (
      <Stack gap="var(--spacing-sm)">
        {introSummary.map((point) => (
          <Stack key={point} direction="row" gap="var(--spacing-xs)" align="start">
            <Icon name="check" size={18} />
            <Typography variant="body-sm">{point}</Typography>
          </Stack>
        ))}
      </Stack>
    ),
    location: (
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
    ),
    providers: (
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body-sm" color="subtle">
          {t('onboarding.providersHint')}
        </Typography>

        {detected.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('onboarding.providersNone')}
          </Typography>
        ) : (
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
                  <Button
                    variant={isActive ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={isActive}
                    onClick={() => updateSettings.mutate({ provider: provider.id })}
                  >
                    {isActive ? t('settings.providerActive') : t('onboarding.providersChoose')}
                  </Button>
                </Stack>
              );
            })}
          </Stack>
        )}

        <Typography variant="caption" color="subtle">
          {t('onboarding.providersDefaultNote')}
        </Typography>
      </Stack>
    ),
  };

  return (
    <>
      <Modal
        isOpen={!pickerOpen}
        // Мастер нельзя «закрыть навсегда» кликом мимо: онбординг снимается только
        // кнопкой «Готово». Пока флаг не выставлен, окно вернётся при перезагрузке.
        onOpenChange={() => undefined}
        title={titles[step]}
        description={descriptions[step]}
        size="md"
        footer={footers[step]}
      >
        {bodies[step]}
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
