import type { WizardStep } from './wizard-logic.types';
import { WIZARD_STEPS } from './wizard-logic.constants';

/** Последний шаг остаётся последним: «Далее» на нём — не переход, а «Готово». */
export function stepAfter(step: WizardStep): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)]!;
}

/** Сохраняемое и применяемое при «Готово» — общая функция контрактов (её зовёт и агент панели). */
export { finishPlan } from '@agentdeck/contracts';
