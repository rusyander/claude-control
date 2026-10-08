import type { Step } from '../OnboardingWizard.types';
import { STEP_ORDER } from './steps.constants';

/** Номер шага для человека: с единицы. */
export function stepNumber(step: Step, order: readonly Step[] = STEP_ORDER): number {
  return order.indexOf(step) + 1;
}
