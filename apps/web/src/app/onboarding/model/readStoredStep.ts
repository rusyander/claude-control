import type { StepStorage } from './steps.types';
import type { Step } from '../OnboardingWizard.types';
import { STEP_STORAGE_KEY } from './steps.constants';
import { isStep } from './steps';

export function readStoredStep(storage: StepStorage | undefined): Step | undefined {
  try {
    const value = storage?.getItem(STEP_STORAGE_KEY);
    return isStep(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
