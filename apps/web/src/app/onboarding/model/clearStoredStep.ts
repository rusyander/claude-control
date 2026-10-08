import type { StepStorage } from './steps.types';
import { STEP_STORAGE_KEY } from './steps.constants';

export function clearStoredStep(storage: StepStorage | undefined): void {
  try {
    storage?.removeItem(STEP_STORAGE_KEY);
  } catch {
    // См. storeStep.
  }
}
