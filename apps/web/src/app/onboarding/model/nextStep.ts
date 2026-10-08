import type { Step } from '../OnboardingWizard.types';
import { STEP_ORDER } from './steps.constants';

export function nextStep(step: Step, order: readonly Step[] = STEP_ORDER): Step | undefined {
  return order[order.indexOf(step) + 1];
}
