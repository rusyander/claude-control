import type { PlatformStatus } from '@agentdeck/contracts';
import type { PlatformWizardModel } from '../model/usePlatformWizard';
import type { WizardStep } from '../model/wizard-logic';

export interface PlatformWizardProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Правка уже настроенного контура: те же шаги, заполненные его значениями. */
  existing?: PlatformStatus;
  /** Шаг, с которого открыть мастер (агент панели: шаг ключа). */
  initialStep?: WizardStep;
}

/** Шаг мастера получает модель целиком: свой кусок состояния он не заводит. */
export interface WizardStepProps {
  model: PlatformWizardModel;
}
