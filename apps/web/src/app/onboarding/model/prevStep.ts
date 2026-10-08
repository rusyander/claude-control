import type { Step } from '../OnboardingWizard.types';
import { STEP_ORDER } from './steps.constants';

export function prevStep(step: Step, order: readonly Step[] = STEP_ORDER): Step | undefined {
  const index = order.indexOf(step);
  return index > 0 ? order[index - 1] : undefined;
}
