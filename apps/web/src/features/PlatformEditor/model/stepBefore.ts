import type { WizardStep } from './wizard-logic.types';
import { WIZARD_STEPS } from './wizard-logic.constants';

/** «Назад» с первого шага никуда не ведёт — закрывает мастер кнопка отмены. */
export function stepBefore(step: WizardStep): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.max(index - 1, 0)]!;
}
