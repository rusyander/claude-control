import type { Step } from '../OnboardingWizard.types';
import { isStep } from './steps';

/**
 * С какого шага открыть мастер.
 *
 * Онбординг уже пройден, но каталог конфигурации стал невалидным — мастер
 * вернулся только ради каталога: сразу шаг каталога, без «Добро пожаловать».
 * Иначе — шаг, сохранённый до перезагрузки, а если его нет — первый.
 */
export function initialStep(input: { onboardingDone: boolean; stored: unknown }): Step {
  if (input.onboardingDone) return 'location';
  return isStep(input.stored) ? input.stored : 'intro';
}
