import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { ClaudeLocation } from '@claude-control/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { FolderPicker } from '@features/FolderPicker';
import { CredentialsFormModal } from '@features/CredentialsEditor';
import { useLocation, useSetLocation, useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useProviderDetect } from '@entities/Provider';
import type { Step } from './OnboardingWizard.types';
import {
  STEP_ORDER,
  clearStoredStep,
  initialStep,
  nextStep,
  prevStep,
  readStoredStep,
  stepNumber,
  storeStep,
} from './model/steps';
import { IntroStep } from './steps/IntroStep';
import { LocationStep } from './steps/LocationStep';
import { ProvidersStep } from './steps/ProvidersStep';
import { AccessStep } from './steps/AccessStep';

/**
 * Приветственный мастер первого запуска. Появляется, пока пользователь не прошёл
 * онбординг ЛИБО пока каталог .claude не определён/невалиден: без рабочего
 * каталога панели нечего показывать, поэтому «Готово» до этого недоступно.
 *
 * Четыре шага (`model/steps.ts`): знакомство → каталог → найденные CLI → доступ
 * Claude Code. Обязателен только каталог; остальное — подсказки, которые можно
 * пропустить. «Пропустить», Escape и крестик при рабочем каталоге равны «Готово»
 * (флаг пишется один раз); без каталога окно не закрывается, и человеку говорят
 * почему. F5 возвращает на тот же шаг (sessionStorage). Онбординг пройден, но
 * каталог пропал — мастер открывается сразу на шаге каталога, без «Добро пожаловать».
 *
 * Живёт в слое app, а не features: это сквозной gate поверх всего интерфейса,
 * который переиспользует features FolderPicker и CredentialsEditor (из features
 * такой импорт запрещён правилом no-cross-feature). Окна выбора папки и ручного
 * доступа рендерятся РЯДОМ с модалкой мастера, а не внутри: закрытая модалка
 * размонтирует детей, и вложенное окно исчезло бы вместе с ней.
 */
export function OnboardingWizard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const location = useLocation();
  const detect = useProviderDetect();
  const setLocation = useSetLocation();
  // Три независимые мутации настроек: у каждой кнопки свой isPending.
  const finishSettings = useUpdateSettings();
  const resetSettings = useUpdateSettings();
  const chooseProvider = useUpdateSettings();

  const [stepState, setStepState] = useState<Step | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  // Синхронный замок: второй клик по «Готово» приходит раньше, чем isPending
  // успевает перерисовать кнопку, и флаг писался дважды.
  const finishing = useRef(false);

  // Без настроек и расположения не решить, показывать ли мастер. Сервер не
  // ответил — говорим прямо и даём повторить, а не молча пропадаем.
  const settingsDown = settings.isError && !settings.data;
  const locationDown = location.isError && !location.data;
  if (settingsDown || locationDown) {
    return (
      <Modal
        isOpen
        onOpenChange={() => undefined}
        title={t('onboarding.loadErrorTitle')}
        size="sm"
        dismissible={false}
        footer={
          <Stack direction="row" justify="end" width="100%">
            <Button
              variant="primary"
              onClick={() => {
                void settings.refetch();
                void location.refetch();
              }}
              isLoading={settings.isFetching || location.isFetching}
            >
              {t('common.retry')}
            </Button>
          </Stack>
        }
      >
        <Typography variant="body-sm" color="subtle">
          {t('onboarding.loadErrorText')}
        </Typography>
      </Modal>
    );
  }
  if (!settings.data || !location.data) return null;

  const isValid = location.data.isValid;
  const onboardingDone = settings.data.onboardingDone;
  if (onboardingDone && isValid) return null;

  const step = stepState ?? initialStep({ onboardingDone, stored: readStoredStep(stepStorage()) });
  const back = prevStep(step);
  const next = nextStep(step);

  const goTo = (target: Step | undefined): void => {
    if (!target) return;
    setStepState(target);
    storeStep(stepStorage(), target);
  };

  const finish = (): void => {
    if (finishing.current) return;
    finishing.current = true;
    finishSettings.mutate(
      { onboardingDone: true },
      {
        onSuccess: () => clearStoredStep(stepStorage()),
        onSettled: () => {
          finishing.current = false;
        },
      },
    );
  };

  // Крестик и Escape: при рабочем каталоге — то же, что «Пропустить». Без него
  // закрыть нельзя (панели нечего показывать), и молчащая кнопка тут хуже отказа.
  const handleOpenChange = (open: boolean): void => {
    if (open) return;
    if (isValid) finish();
    else toast.error(t('onboarding.cannotSkip'));
  };

  const applyPath = (path: string): void => {
    setLocation.mutate(path, {
      // Сервер отвечает 200 и на отказанный путь — хвалим только принятый.
      onSuccess: (result) => {
        if (result.isValid) toast.success(t('toasts.locationChanged'));
      },
    });
  };

  const resetLocation = (): void => {
    resetSettings.mutate(
      { claudeDirOverride: '' },
      {
        onSuccess: () => {
          // Отказ прошлой попытки больше не относится к текущему каталогу.
          setLocation.reset();
          // Смена каталога меняет вообще всё, что показывает приложение.
          void queryClient.invalidateQueries();
          toast.success(t('toasts.locationChanged'));
        },
      },
    );
  };

  const applyProblem = describeApplyProblem(
    setLocation.data,
    setLocation.error,
    t('errors.locationHint'),
  );

  const titles: Record<Step, string> = {
    intro: t('onboarding.introTitle'),
    location: t('onboarding.locationTitle'),
    providers: t('onboarding.providersTitle'),
    access: t('onboarding.accessTitle'),
  };
  const subtitles: Record<Step, string> = {
    intro: t('onboarding.introSubtitle'),
    location: t('onboarding.locationSubtitle'),
    providers: t('onboarding.providersSubtitle'),
    access: t('onboarding.accessSubtitle'),
  };
  const counter = t('onboarding.stepOf', { current: stepNumber(step), total: STEP_ORDER.length });

  const bodies: Record<Step, ReactNode> = {
    intro: <IntroStep />,
    location: (
      <LocationStep
        location={location.data}
        onApply={applyPath}
        isApplying={setLocation.isPending}
        applyProblem={applyProblem}
        onPickFolder={() => setPickerOpen(true)}
        onReset={resetLocation}
        isResetting={resetSettings.isPending}
      />
    ),
    providers: (
      <ProvidersStep
        detect={detect.data}
        isLoading={detect.isPending}
        isError={detect.isError}
        onRetry={() => void detect.refetch()}
        activeProviderId={settings.data.provider}
        onChoose={(providerId) => chooseProvider.mutate({ provider: providerId })}
        isChoosing={chooseProvider.isPending}
      />
    ),
    access: <AccessStep onSetManually={() => setCredentialsOpen(true)} />,
  };

  // Мастер вернулся из-за пропавшего каталога — пропускать нечего и назад
  // к знакомству идти незачем: как только каталог в порядке, окно уйдёт само.
  const canSkip = isValid && !onboardingDone && next !== undefined;
  const showBack = back !== undefined && !onboardingDone;
  // Дальше — только с рабочим каталогом: без него панели нечего показывать.
  const nextDisabled = !isValid && step !== 'intro';

  const footer = (
    <Stack direction="row" justify="between" align="center" gap="var(--spacing-xs)" width="100%">
      <div>
        {showBack && (
          <Button variant="ghost" onClick={() => goTo(back)}>
            {t('onboarding.back')}
          </Button>
        )}
      </div>
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        {canSkip && (
          <Button variant="ghost" onClick={finish} isLoading={finishSettings.isPending}>
            {t('onboarding.skip')}
          </Button>
        )}
        {next ? (
          <Button variant="primary" onClick={() => goTo(next)} disabled={nextDisabled}>
            {t('onboarding.next')}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={finish}
            disabled={!isValid}
            isLoading={finishSettings.isPending}
          >
            {t('onboarding.done')}
          </Button>
        )}
      </Stack>
    </Stack>
  );

  return (
    <>
      <Modal
        isOpen={!pickerOpen && !credentialsOpen}
        onOpenChange={handleOpenChange}
        title={titles[step]}
        description={`${counter} · ${subtitles[step]}`}
        size="md"
        footer={footer}
      >
        {bodies[step]}
      </Modal>

      <FolderPicker
        isOpen={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t('onboarding.pickerTitle')}
        hint={t('onboarding.pickerHint')}
        onPick={(path) => {
          applyPath(path);
          setPickerOpen(false);
        }}
      />

      <CredentialsFormModal isOpen={credentialsOpen} onOpenChange={setCredentialsOpen} />
    </>
  );
}

/** Причина отказа — у поля: текст сервера для непринятого пути, иначе ошибка запроса. */
function describeApplyProblem(
  result: ClaudeLocation | undefined,
  error: unknown,
  fallback: string,
): string | undefined {
  if (result && !result.isValid) return result.problem ?? fallback;
  if (error) return toErrorMessage(error);
  return undefined;
}

/** sessionStorage может быть недоступен (приватный режим, запрет данных сайта) — тогда шаг не запоминается. */
function stepStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
