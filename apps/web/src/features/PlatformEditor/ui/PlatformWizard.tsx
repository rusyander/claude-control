import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { usePlatformWizard } from '../model/usePlatformWizard';
import { WIZARD_STEPS } from '../model/wizard-logic';
import { StepAddress } from './StepAddress';
import { StepToken } from './StepToken';
import { StepCapabilities } from './StepCapabilities';
import { StepTargets } from './StepTargets';
import type { PlatformWizardProps } from './PlatformWizard.types';
import styles from './PlatformWizard.module.scss';

/**
 * Мастер подключения контура: адрес → ключ → что доступно → где применять.
 *
 * Четыре шага, а не одна форма, по одной причине: третий шаг показывает ОТВЕТ
 * контура, и он обязан стоять между вводом ключа и выбором целей. Человек,
 * выбирающий цели, уже знает, что панель нашла на самом деле, — а не то, что
 * обещает документация платформы.
 */
export function PlatformWizard({ isOpen, onOpenChange, existing }: PlatformWizardProps) {
  const { t } = useTranslation();
  const model = usePlatformWizard({
    ...(existing ? { existing } : {}),
    onDone: () => onOpenChange(false),
  });

  const index = WIZARD_STEPS.indexOf(model.step);
  const isLast = index === WIZARD_STEPS.length - 1;

  const goNext = (): void => {
    // Со шага ключа уходим ЧЕРЕЗ пробу: следующий экран показывает её ответ, и
    // пустить туда без запроса значило бы показать вчерашний.
    if (model.step === 'token') {
      void model.probeNow().then(model.next);
      return;
    }
    model.next();
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={existing ? t('platform.wizardEditTitle') : t('platform.wizardTitle')}
      description={t('platform.wizardHint')}
      size="lg"
      footer={
        <>
          {index > 0 && (
            <Button variant="secondary" onClick={model.back} disabled={model.isBusy}>
              {t('platform.back')}
            </Button>
          )}
          {isLast ? (
            <Button
              onClick={() => void model.finish()}
              disabled={!model.isValid || model.isBusy}
              isLoading={model.isBusy}
            >
              {t('platform.wizardFinish')}
            </Button>
          ) : (
            <Button
              onClick={goNext}
              disabled={!model.isValid || model.isBusy}
              isLoading={model.isProbing}
            >
              {t('platform.next')}
            </Button>
          )}
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <ol className={styles.steps}>
          {WIZARD_STEPS.map((step, position) => (
            <li
              key={step}
              className={position === index ? styles.stepCurrent : styles.step}
              {...(position === index ? { 'aria-current': 'step' as const } : {})}
            >
              <Typography variant="caption" as="span">
                {position + 1}. {t(`platform.wizardStep.${step}`)}
              </Typography>
            </li>
          ))}
        </ol>

        {model.step === 'address' && <StepAddress model={model} />}
        {model.step === 'token' && <StepToken model={model} />}
        {model.step === 'capabilities' && <StepCapabilities model={model} />}
        {model.step === 'targets' && <StepTargets model={model} />}
      </Stack>
    </Modal>
  );
}
