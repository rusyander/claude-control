import type { Step } from '../OnboardingWizard.types';
import { STEP_ORDER } from './steps.constants';

export function isStep(value: unknown): value is Step {
  return typeof value === 'string' && (STEP_ORDER as readonly string[]).includes(value);
}
