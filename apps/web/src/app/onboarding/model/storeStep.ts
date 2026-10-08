import type { StepStorage } from './steps.types';
import type { Step } from '../OnboardingWizard.types';
import { STEP_STORAGE_KEY } from './steps.constants';

export function storeStep(storage: StepStorage | undefined, step: Step): void {
  try {
    storage?.setItem(STEP_STORAGE_KEY, step);
  } catch {
    // Нет хранилища — после F5 мастер просто начнётся с первого шага.
  }
}
